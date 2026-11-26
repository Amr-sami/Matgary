-- Cash drawer reconciliation + Z-report.
--
-- Every cashier shift is a row in cash_shifts: cashier opens with an
-- opening_float, every cash sale / refund / expense / movement during the
-- shift is linked, then the cashier counts the physical drawer at close
-- and the difference (variance = counted - expected) lands in the row.
-- Owner reviews any non-zero variance from a manager inbox.
--
-- cash_movements captures the ad-hoc cash flows that aren't sales /
-- expenses (e.g. owner deposits change into the drawer mid-shift).
--
-- Sales / expenses / returns get a nullable cash_shift_id so legacy rows
-- (and non-cash payment methods) stay untouched.

CREATE TABLE IF NOT EXISTS "cash_shifts" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "branch_id"           uuid NOT NULL REFERENCES "branches"("id") ON DELETE RESTRICT,
  "cashier_user_id"     uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,

  "status"              text NOT NULL DEFAULT 'open'
                          CHECK ("status" IN ('open', 'closed', 'reviewed')),

  "opened_at"           timestamptz NOT NULL DEFAULT now(),
  "opened_by_user_id"   uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "opening_float"       numeric(14,2) NOT NULL DEFAULT 0
                          CHECK ("opening_float" >= 0),
  "opening_note"        text,

  "closed_at"           timestamptz,
  "closed_by_user_id"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "expected_cash"       numeric(14,2),
  "counted_cash"        numeric(14,2),
  "variance"            numeric(14,2) GENERATED ALWAYS AS ("counted_cash" - "expected_cash") STORED,
  "closing_note"        text,
  "close_reason"        text CHECK ("close_reason" IN ('cashier', 'auto_midnight', 'forced')),

  "reviewed_at"         timestamptz,
  "reviewed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "review_note"         text,

  -- Frozen snapshot of all sale/expense aggregates at close. Lets the
  -- Z-report stay stable even if a sale is later edited or returned.
  "totals_snapshot"     jsonb,

  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "cash_shifts_tenant_branch_date_idx"
  ON "cash_shifts" ("tenant_id", "branch_id", "opened_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_shifts_tenant_cashier_idx"
  ON "cash_shifts" ("tenant_id", "cashier_user_id", "opened_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_shifts_review_queue_idx"
  ON "cash_shifts" ("tenant_id", "status", "variance")
  WHERE "status" = 'closed' AND abs("variance") >= 1;
--> statement-breakpoint
-- At most one OPEN shift per (tenant, branch, cashier). The cashier closes
-- their current shift before they can open a new one.
CREATE UNIQUE INDEX IF NOT EXISTS "cash_shifts_one_open_per_cashier"
  ON "cash_shifts" ("tenant_id", "branch_id", "cashier_user_id")
  WHERE "status" = 'open';
--> statement-breakpoint

ALTER TABLE "cash_shifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_shifts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "cash_shifts_tenant_isolation" ON "cash_shifts"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cash_movements" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "shift_id"            uuid NOT NULL REFERENCES "cash_shifts"("id") ON DELETE CASCADE,
  -- cash_in: misc cash deposited (e.g. customer settles an old deferred)
  -- cash_out: misc cash taken out (e.g. owner change-fund top-up)
  -- paid_in: owner deposits cash INTO the drawer
  -- paid_out: owner withdraws cash FROM the drawer (banking, supplier petty)
  "kind"                text NOT NULL
                          CHECK ("kind" IN ('cash_in', 'cash_out', 'paid_in', 'paid_out')),
  "amount"              numeric(14,2) NOT NULL CHECK ("amount" > 0),
  "reason"              text NOT NULL,
  "recorded_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "recorded_at"         timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_movements_shift_idx"
  ON "cash_movements" ("shift_id", "recorded_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_movements_tenant_idx"
  ON "cash_movements" ("tenant_id", "recorded_at");
--> statement-breakpoint

ALTER TABLE "cash_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "cash_movements_tenant_isolation" ON "cash_movements"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- Sales / expenses / returns linkage. Nullable so legacy + non-cash rows
-- carry NULL and are excluded from Z-report aggregates.
ALTER TABLE "sales"   ADD COLUMN IF NOT EXISTS "cash_shift_id" uuid REFERENCES "cash_shifts"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "cash_shift_id" uuid REFERENCES "cash_shifts"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN IF NOT EXISTS "cash_shift_id" uuid REFERENCES "cash_shifts"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sales_cash_shift_idx"
  ON "sales" ("cash_shift_id") WHERE "cash_shift_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expenses_cash_shift_idx"
  ON "expenses" ("cash_shift_id") WHERE "cash_shift_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "returns_cash_shift_idx"
  ON "returns" ("cash_shift_id") WHERE "cash_shift_id" IS NOT NULL;
--> statement-breakpoint

-- Per-branch feature flag + variance-note threshold. Default OFF so
-- existing tenants aren't suddenly blocked from cash sales when this
-- ships; they opt in from /settings/cash-drawer.
ALTER TABLE "shop_settings"
  ADD COLUMN IF NOT EXISTS "cash_reconciliation_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "shop_settings"
  ADD COLUMN IF NOT EXISTS "cash_variance_note_threshold" numeric(14,2) NOT NULL DEFAULT 50;
--> statement-breakpoint
