-- Per-PO payment tracking. Adds purchase_orders.paid_amount and a
-- purchase_order_payments history table so each chunk of money paid against
-- a PO is auditable. supplier.balance keeps its existing meaning (running
-- amount owed) and is updated atomically alongside paid_amount.
--
-- Backfill: existing received POs are marked paid in full. The pre-feature
-- workflow tracked settlement only at the supplier level (via expenses),
-- so the cleanest assumption for legacy rows is that they were settled
-- outside the new per-PO mechanism. New POs use the proper flow.

ALTER TABLE "purchase_orders"
  ADD COLUMN IF NOT EXISTS "paid_amount" numeric(14,2) NOT NULL DEFAULT 0;
--> statement-breakpoint

UPDATE "purchase_orders"
SET "paid_amount" = "total"
WHERE "status" = 'received' AND "paid_amount" = 0;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "purchase_order_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "branch_id" uuid REFERENCES "branches"("id") ON DELETE RESTRICT,
  "purchase_order_id" uuid NOT NULL REFERENCES "purchase_orders"("id") ON DELETE CASCADE,
  "supplier_id" uuid NOT NULL REFERENCES "suppliers"("id") ON DELETE RESTRICT,
  "amount" numeric(14,2) NOT NULL CHECK ("amount" > 0),
  "method" text NOT NULL DEFAULT 'cash',
  "paid_at" timestamptz NOT NULL DEFAULT now(),
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "po_payments_tenant_po_idx"
  ON "purchase_order_payments" ("tenant_id", "purchase_order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "po_payments_tenant_supplier_date_idx"
  ON "purchase_order_payments" ("tenant_id", "supplier_id", "paid_at");
--> statement-breakpoint

ALTER TABLE "purchase_order_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_order_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "purchase_order_payments_tenant_isolation" ON "purchase_order_payments"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
