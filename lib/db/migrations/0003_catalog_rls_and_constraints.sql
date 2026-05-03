-- Tighten product price columns to numeric(12,2) (Drizzle stored them as text
-- because the schema declares text for precision-on-the-wire).
ALTER TABLE "products"
  ALTER COLUMN "price" TYPE numeric(12,2) USING "price"::numeric(12,2),
  ALTER COLUMN "cost_price" TYPE numeric(12,2) USING "cost_price"::numeric(12,2);
--> statement-breakpoint

-- Per-tenant unique constraints
CREATE UNIQUE INDEX "categories_tenant_key_uniq" ON "categories" ("tenant_id", "key");
--> statement-breakpoint
CREATE UNIQUE INDEX "category_attrs_category_key_uniq" ON "category_attributes" ("category_id", "key");
--> statement-breakpoint
CREATE UNIQUE INDEX "category_attr_values_attr_key_uniq" ON "category_attribute_values" ("attribute_id", "key");
--> statement-breakpoint
CREATE UNIQUE INDEX "brands_tenant_category_name_uniq" ON "brands" ("tenant_id", "category_id", "name");
--> statement-breakpoint

-- RLS on every catalog table
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY "categories_tenant_isolation" ON "categories"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "category_attributes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "category_attributes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "category_attributes_tenant_isolation" ON "category_attributes"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "category_attribute_values" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "category_attribute_values" FORCE ROW LEVEL SECURITY;
CREATE POLICY "category_attribute_values_tenant_isolation" ON "category_attribute_values"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "brands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brands" FORCE ROW LEVEL SECURITY;
CREATE POLICY "brands_tenant_isolation" ON "brands"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
CREATE POLICY "products_tenant_isolation" ON "products"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "product_attribute_values" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_attribute_values" FORCE ROW LEVEL SECURITY;
CREATE POLICY "product_attribute_values_tenant_isolation" ON "product_attribute_values"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "product_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY "product_history_tenant_isolation" ON "product_history"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
