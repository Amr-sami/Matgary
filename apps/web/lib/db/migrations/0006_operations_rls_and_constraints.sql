-- Tighten money columns to numeric(12,2) — Drizzle stored them as text for
-- precision-on-the-wire; PG-side numeric is what we want for aggregates.
ALTER TABLE "sales"
  ALTER COLUMN "price_per_unit"     TYPE numeric(12,2) USING "price_per_unit"::numeric(12,2),
  ALTER COLUMN "cost_price_at_sale" TYPE numeric(12,2) USING "cost_price_at_sale"::numeric(12,2),
  ALTER COLUMN "subtotal"           TYPE numeric(12,2) USING "subtotal"::numeric(12,2),
  ALTER COLUMN "discount_value"     TYPE numeric(12,2) USING "discount_value"::numeric(12,2),
  ALTER COLUMN "discount_amount"    TYPE numeric(12,2) USING "discount_amount"::numeric(12,2),
  ALTER COLUMN "total_price"        TYPE numeric(12,2) USING "total_price"::numeric(12,2);
--> statement-breakpoint
ALTER TABLE "expenses"
  ALTER COLUMN "amount" TYPE numeric(12,2) USING "amount"::numeric(12,2);
--> statement-breakpoint

-- RLS on operations tables
ALTER TABLE "sales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sales_tenant_isolation" ON "sales"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "returns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "returns" FORCE ROW LEVEL SECURITY;
CREATE POLICY "returns_tenant_isolation" ON "returns"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "expenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "expenses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "expenses_tenant_isolation" ON "expenses"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
