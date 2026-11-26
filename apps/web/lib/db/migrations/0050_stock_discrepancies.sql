-- S7 oversell (doc 02 §2.2 S13, doc 06 §6.5): the offline POS replays a
-- sale the customer already walked out with. When a line exceeds the shelf
-- and the cashier confirms "sell anyway", the sale books as rung, the
-- product is driven to 0, and ONE row lands here per oversold product so the
-- owner can review discrepancies without parsing product_history notes.
-- `requested - available` is the phantom quantity (sold, never on the shelf).

CREATE TABLE IF NOT EXISTS "stock_discrepancies" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           UUID NOT NULL REFERENCES "tenants"("id")   ON DELETE CASCADE,
  "branch_id"           UUID NOT NULL REFERENCES "branches"("id")  ON DELETE RESTRICT,
  "product_id"          UUID NOT NULL,
  "product_name"        TEXT NOT NULL,
  "invoice_id"          TEXT NOT NULL,
  "requested"           INTEGER NOT NULL,
  "available"           INTEGER NOT NULL,
  "recorded_by_user_id" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The review list: "this tenant's discrepancies, newest first".
CREATE INDEX IF NOT EXISTS "stock_discrepancies_tenant_created_idx"
  ON "stock_discrepancies" ("tenant_id", "created_at");

ALTER TABLE "stock_discrepancies" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stock_discrepancies_tenant_isolation" ON "stock_discrepancies"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
