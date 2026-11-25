-- Payroll V1 — the ERP side of attendance + compensation.
--
-- Up to now `payroll_periods` existed (0008) but nothing operational wrote to
-- it; only the P&L read `grossAmount + adjustmentsAmount` for finalized rows.
-- V1 makes payroll a first-class lifecycle: MISSING → DRAFT → FINALIZED, with
-- void→redo as the correction path. On finalize we stamp a full snapshot so
-- a finalized period is self-contained and reproducible — later edits to
-- compensation rows, attendance, sales, or commission must not mutate it.
--
-- Scope:
--   1. Extend employee_compensation with commission + bonus-eligibility flags
--   2. Extend payroll_periods with snapshot + lifecycle + commission/net
--   3. Add leave_requests.kind ('paid'|'unpaid') so leave can offset gross
--   4. New payroll_adjustments table (monthly bonus/deduction entries)
--   5. Postgres trigger locking finalized rows (only void columns may change)
--
-- All financial columns use numeric(12,2); hours stay numeric(8,2) like 0008.
-- Immutability is enforced in the database, not application code, so even a
-- rogue SQL session cannot silently edit a finalized sheet.

-- ─── 1. employee_compensation ── commission + bonus eligibility ─────────────
-- `commission_rate` is a flat percentage (0..100) applied to the attribution
-- base. V1 ships a single rate per employee; percentage brackets can slot in
-- later without a schema change (add commission_brackets later).
-- `commission_base` picks which revenue the rate multiplies — V1 supports
-- 'gross_sales' (sum of sale lines attributed to the employee, less returns).
-- 'profit_contribution' is the planned V2 base; keep it in the CHECK so the
-- UI can gate it without another migration.
-- `bonus_eligible` is the Owner-controlled toggle for "this employee can earn
-- monthly bonuses". Default false — the Owner opts people in explicitly.

ALTER TABLE "employee_compensation"
  ADD COLUMN IF NOT EXISTS "commission_rate" numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "commission_base" text NOT NULL DEFAULT 'gross_sales',
  ADD COLUMN IF NOT EXISTS "bonus_eligible" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE "employee_compensation"
  DROP CONSTRAINT IF EXISTS "employee_compensation_commission_base_check";
--> statement-breakpoint
ALTER TABLE "employee_compensation"
  ADD CONSTRAINT "employee_compensation_commission_base_check"
    CHECK ("commission_base" IN ('gross_sales', 'profit_contribution'));
--> statement-breakpoint
ALTER TABLE "employee_compensation"
  DROP CONSTRAINT IF EXISTS "employee_compensation_commission_rate_check";
--> statement-breakpoint
ALTER TABLE "employee_compensation"
  ADD CONSTRAINT "employee_compensation_commission_rate_check"
    CHECK ("commission_rate" >= 0 AND "commission_rate" <= 100);
--> statement-breakpoint

-- ─── 2. payroll_periods ── snapshot, lifecycle, commission, void ────────────
-- `snapshot` is the engine's full output at finalize time: regularHours,
-- overtimeHours, attendance window, leave days (paid/unpaid), sales subtotal,
-- returns, commission math inputs, per-adjustment breakdown, warnings. Stored
-- JSONB so the shape can evolve across calculation_version bumps.
--
-- `compensation_snapshot` is the specific employee_compensation row that was
-- in force at finalize time (payType, baseSalaryMonthly, hourlyRate,
-- standardMonthlyHours, commissionRate, commissionBase, bonusEligible,
-- effectiveFrom). Finalized rows must reproduce their math without joining
-- the compensation table — rate changes next month cannot rewrite history.
--
-- `calculation_version` is a cheap migration hint: when the engine changes
-- its math (e.g. new overtime rule), bump the version in code and write it
-- here. Readers surface "recalculated under v2" context in the UI.
--
-- `commission_amount` + `adjustments_total` + `net_amount` are the executor-
-- consumed totals. `net_amount = gross_amount + commission_amount +
-- adjustments_total` (adjustments carry sign — bonuses positive, deductions
-- negative). Stored even though derivable: finalized rows must not depend on
-- a recomputation at read time.
--
-- `voided_at` / `voided_by_user_id` / `void_reason` are the one-way exit from
-- FINALIZED. A voided row stays in the table (audit trail, PDF reproducibility)
-- but the P&L excludes it, and a new DRAFT can be opened for the same (tenant,
-- employee, period_start) pair. Hence the partial unique index below.

ALTER TABLE "payroll_periods"
  ADD COLUMN IF NOT EXISTS "snapshot" jsonb,
  ADD COLUMN IF NOT EXISTS "compensation_snapshot" jsonb,
  ADD COLUMN IF NOT EXISTS "calculation_version" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "commission_amount" numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "adjustments_total" numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "net_amount" numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "voided_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "voided_by_user_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "void_reason" text;
--> statement-breakpoint

-- Extend the status check to allow 'voided' alongside the old values.
ALTER TABLE "payroll_periods"
  DROP CONSTRAINT IF EXISTS "payroll_periods_status_check";
--> statement-breakpoint
ALTER TABLE "payroll_periods"
  ADD CONSTRAINT "payroll_periods_status_check"
    CHECK ("status" IN ('draft','finalized','voided'));
--> statement-breakpoint

-- Exactly one non-voided row per (tenant, employee, month). Voided rows are
-- excluded so a correction cycle (void → new draft) doesn't collide with the
-- original. The partial index does what a plain UNIQUE constraint cannot.
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_periods_tenant_employee_period_live_idx"
  ON "payroll_periods" ("tenant_id", "employee_id", "period_start")
  WHERE "status" <> 'voided';
--> statement-breakpoint

-- Reader index — list all periods for a given month across employees.
CREATE INDEX IF NOT EXISTS "payroll_periods_tenant_period_status_idx"
  ON "payroll_periods" ("tenant_id", "period_start", "status");
--> statement-breakpoint

-- ─── 3. leave_requests.kind ── paid vs unpaid ───────────────────────────────
-- V1 adds a single flag the engine reads: paid leave days count toward the
-- fixed-salary accrual, unpaid days reduce it. The approver picks when
-- approving. Default 'unpaid' so legacy rows don't retroactively credit
-- employees.

ALTER TABLE "leave_requests"
  ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'unpaid';
--> statement-breakpoint
ALTER TABLE "leave_requests"
  DROP CONSTRAINT IF EXISTS "leave_requests_kind_check";
--> statement-breakpoint
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_kind_check"
    CHECK ("kind" IN ('paid','unpaid'));
--> statement-breakpoint

-- ─── 4. payroll_adjustments ── bonus / deduction entries ────────────────────
-- Owner-authored monthly adjustments per employee: positive for bonuses /
-- advances recovered, negative for deductions. The engine sums these into
-- `adjustments_total` on calculate; at finalize the live set is folded into
-- the snapshot and locked in. `period_month` is the normalized first-of-month
-- timestamp (UTC midnight of day 1), so it joins cleanly to payroll_periods.

CREATE TABLE IF NOT EXISTS "payroll_adjustments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "employee_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "period_month" timestamptz NOT NULL,
  -- 'bonus' | 'deduction' | 'advance_repayment' | 'correction'. Kind is a
  -- label for the UI; `amount` carries the actual sign. CHECK keeps the kind
  -- consistent with the sign so a "bonus" cannot be negative by accident.
  "kind" text NOT NULL,
  "amount" numeric(12,2) NOT NULL,
  "reason" text,
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "voided_at" timestamptz,
  "voided_by_user_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "payroll_adjustments_kind_check"
    CHECK ("kind" IN ('bonus','deduction','advance_repayment','correction')),
  CONSTRAINT "payroll_adjustments_sign_check" CHECK (
    ("kind" = 'bonus' AND "amount" > 0)
    OR ("kind" = 'deduction' AND "amount" < 0)
    OR ("kind" = 'advance_repayment' AND "amount" < 0)
    OR ("kind" = 'correction')
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_adjustments_tenant_employee_month_idx"
  ON "payroll_adjustments" ("tenant_id", "employee_id", "period_month");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_adjustments_tenant_month_idx"
  ON "payroll_adjustments" ("tenant_id", "period_month");
--> statement-breakpoint

-- ─── 5. Immutability trigger for finalized periods ──────────────────────────
-- Finalized rows are append-only except for the void columns. Any attempt to
-- edit grossAmount, commission, adjustments, snapshot, etc. on a FINALIZED
-- row is rejected at the database level. The void transition itself is the
-- only allowed update: it sets status='voided', voided_at, voided_by_user_id,
-- void_reason. We detect it by checking that status actually moves away from
-- 'finalized'.
--
-- The trigger fires BEFORE UPDATE OF <immutable columns>; if any immutable
-- column differs AND the row was previously FINALIZED AND the update is not
-- the void transition, the trigger raises.

CREATE OR REPLACE FUNCTION "payroll_periods_immutable_when_finalized"()
RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'finalized' THEN
    -- Void transition: status flips to 'voided', metadata columns get stamped.
    -- Anything else that touches the body of the sheet is rejected.
    IF NEW."status" = 'voided' AND OLD."status" = 'finalized' THEN
      -- Allow only void-related columns to differ.
      IF NEW."regular_hours" IS DISTINCT FROM OLD."regular_hours"
        OR NEW."overtime_hours" IS DISTINCT FROM OLD."overtime_hours"
        OR NEW."gross_amount" IS DISTINCT FROM OLD."gross_amount"
        OR NEW."commission_amount" IS DISTINCT FROM OLD."commission_amount"
        OR NEW."adjustments_amount" IS DISTINCT FROM OLD."adjustments_amount"
        OR NEW."adjustments_total" IS DISTINCT FROM OLD."adjustments_total"
        OR NEW."net_amount" IS DISTINCT FROM OLD."net_amount"
        OR NEW."snapshot" IS DISTINCT FROM OLD."snapshot"
        OR NEW."compensation_snapshot" IS DISTINCT FROM OLD."compensation_snapshot"
        OR NEW."calculation_version" IS DISTINCT FROM OLD."calculation_version"
        OR NEW."period_start" IS DISTINCT FROM OLD."period_start"
        OR NEW."period_end" IS DISTINCT FROM OLD."period_end"
        OR NEW."employee_id" IS DISTINCT FROM OLD."employee_id"
        OR NEW."finalized_at" IS DISTINCT FROM OLD."finalized_at"
        OR NEW."finalized_by_user_id" IS DISTINCT FROM OLD."finalized_by_user_id"
      THEN
        RAISE EXCEPTION 'payroll_periods: finalized row is immutable except for void metadata';
      END IF;
      RETURN NEW;
    END IF;
    -- No status change (still finalized) or any other status → forbidden.
    RAISE EXCEPTION 'payroll_periods: finalized row cannot be edited (only voided)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "payroll_periods_immutable_when_finalized_trg" ON "payroll_periods";
--> statement-breakpoint
CREATE TRIGGER "payroll_periods_immutable_when_finalized_trg"
  BEFORE UPDATE ON "payroll_periods"
  FOR EACH ROW EXECUTE FUNCTION "payroll_periods_immutable_when_finalized"();
--> statement-breakpoint

-- ─── 6. RLS on payroll_adjustments ──────────────────────────────────────────
-- Mirror the shape of payroll_periods (0008): tenant isolation via
-- app.tenant_id GUC, FORCE so rls applies to table owners too.

ALTER TABLE "payroll_adjustments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payroll_adjustments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "payroll_adjustments_tenant_isolation" ON "payroll_adjustments"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
