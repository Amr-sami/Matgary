-- Suppliers, purchase orders, and purchase order items.
-- Adds optional supplier_id FK to products and expenses.

CREATE TABLE IF NOT EXISTS "suppliers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "phone" text,
  "email" text,
  "address" text,
  "notes" text,
  "balance" numeric(14,2) NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suppliers_tenant_idx" ON "suppliers" ("tenant_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "purchase_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "supplier_id" uuid NOT NULL REFERENCES "suppliers"("id") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft','received','cancelled')),
  "order_date" timestamptz NOT NULL DEFAULT now(),
  "received_date" timestamptz,
  "notes" text,
  "total" numeric(14,2) NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_tenant_supplier_idx"
  ON "purchase_orders" ("tenant_id", "supplier_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_tenant_date_idx"
  ON "purchase_orders" ("tenant_id", "order_date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "purchase_order_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "purchase_order_id" uuid NOT NULL REFERENCES "purchase_orders"("id") ON DELETE CASCADE,
  "product_id" uuid REFERENCES "products"("id") ON DELETE SET NULL,
  "product_name" text NOT NULL,
  "quantity" integer NOT NULL CHECK ("quantity" > 0),
  "unit_cost" numeric(14,2) NOT NULL,
  "line_total" numeric(14,2) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "po_items_tenant_po_idx"
  ON "purchase_order_items" ("tenant_id", "purchase_order_id");
--> statement-breakpoint

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "supplier_id" uuid REFERENCES "suppliers"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_tenant_supplier_idx"
  ON "products" ("tenant_id", "supplier_id");
--> statement-breakpoint

ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "supplier_id" uuid REFERENCES "suppliers"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expenses_tenant_supplier_idx"
  ON "expenses" ("tenant_id", "supplier_id");
--> statement-breakpoint

-- RLS policies — tenant isolation via app.tenant_id GUC, mirroring 0008.
ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppliers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "suppliers_tenant_isolation" ON "suppliers"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "purchase_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "purchase_orders_tenant_isolation" ON "purchase_orders"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "purchase_order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_order_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "purchase_order_items_tenant_isolation" ON "purchase_order_items"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
