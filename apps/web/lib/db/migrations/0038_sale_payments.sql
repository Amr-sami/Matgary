-- Sale payments ledger — every individual payment event recorded against
-- a sale row, so the customer detail page can show a real timeline
-- instead of just the latest `partial_paid_at`.
--
-- Before this migration the only payment trail was:
--   sales.amount_paid       — running total
--   sales.partial_paid_at   — timestamp of MOST RECENT partial (overwritten)
--   sales.paid_at           — timestamp of the final settlement
--
-- Which means a cashier doing { partial 500, partial 300, settle 200 }
-- only saw the LAST partial date, not the journey. This table fixes that:
-- every settlement (from /api/sales/settle, the /paid endpoint, and the
-- bulk mark-all-paid) inserts one row here. The `cash_shift_id` lets
-- Z-report and cash reconciliation see customer settlements alongside
-- normal sales movements.
--
-- Sale is FK with ON DELETE CASCADE — if a sale row goes away (via void),
-- its payment ledger goes with it. That matches the existing void
-- semantics (we never keep payment trails for deleted invoices).

CREATE TABLE IF NOT EXISTS "sale_payments" (
  "id"                     uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"              uuid           NOT NULL REFERENCES "tenants"("id")     ON DELETE CASCADE,
  "sale_id"                uuid           NOT NULL REFERENCES "sales"("id")       ON DELETE CASCADE,
  "amount"                 numeric(14,2)  NOT NULL CHECK ("amount" > 0),
  "method"                 text           NOT NULL CHECK ("method" IN ('cash', 'instapay', 'card', 'initial')),
  "recorded_at"            timestamptz    NOT NULL DEFAULT now(),
  "recorded_by_user_id"    uuid           REFERENCES "users"("id")                ON DELETE SET NULL,
  "cash_shift_id"          uuid           REFERENCES "cash_shifts"("id")          ON DELETE SET NULL,
  "note"                   text
);

-- Per-sale lookups (the customer detail page calls these for every
-- displayed invoice) and per-tenant time-ordered scans (admin reports).
CREATE INDEX IF NOT EXISTS "sale_payments_sale_idx"
  ON "sale_payments" ("sale_id", "recorded_at");
CREATE INDEX IF NOT EXISTS "sale_payments_tenant_date_idx"
  ON "sale_payments" ("tenant_id", "recorded_at");

-- Backfill: every existing sale with `amount_paid > 0` gets ONE legacy
-- payment row so the new history view doesn't look empty for old data.
-- We use the `initial` method to distinguish back-filled rows from real
-- events recorded after this migration. recorded_at falls back to the
-- sale date when paid_at is null (e.g. partial-paid rows that never
-- fully settled — partial_paid_at would also work but sale_date is the
-- safer worst case).
INSERT INTO "sale_payments"
  ("tenant_id", "sale_id", "amount", "method", "recorded_at", "note")
SELECT
  s."tenant_id",
  s."id",
  CAST(s."amount_paid" AS numeric(14,2)),
  'initial',
  COALESCE(s."paid_at", s."partial_paid_at", s."sale_date"),
  'backfill 0038'
FROM "sales" s
WHERE s."amount_paid" > 0
  AND NOT EXISTS (
    SELECT 1 FROM "sale_payments" p WHERE p."sale_id" = s."id"
  );

-- RLS: payments belong to a tenant via their sale row. Force the same
-- tenant-isolation policy other sale-derived tables use.
ALTER TABLE "sale_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sale_payments" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sale_payments_tenant_isolation" ON "sale_payments";
CREATE POLICY "sale_payments_tenant_isolation"
  ON "sale_payments"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
