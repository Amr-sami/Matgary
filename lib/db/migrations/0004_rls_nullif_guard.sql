-- Replace every RLS policy with a NULLIF-guarded version. Without this,
-- a query that runs WITHOUT setting app.tenant_id throws "invalid input
-- syntax for type uuid" instead of returning 0 rows. We want the latter
-- so RLS is always graceful when the app forgets to scope a tenant.

DROP POLICY IF EXISTS "shop_settings_tenant_isolation" ON "shop_settings";
CREATE POLICY "shop_settings_tenant_isolation" ON "shop_settings"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

DROP POLICY IF EXISTS "categories_tenant_isolation" ON "categories";
CREATE POLICY "categories_tenant_isolation" ON "categories"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

DROP POLICY IF EXISTS "category_attributes_tenant_isolation" ON "category_attributes";
CREATE POLICY "category_attributes_tenant_isolation" ON "category_attributes"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

DROP POLICY IF EXISTS "category_attribute_values_tenant_isolation" ON "category_attribute_values";
CREATE POLICY "category_attribute_values_tenant_isolation" ON "category_attribute_values"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

DROP POLICY IF EXISTS "brands_tenant_isolation" ON "brands";
CREATE POLICY "brands_tenant_isolation" ON "brands"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

DROP POLICY IF EXISTS "products_tenant_isolation" ON "products";
CREATE POLICY "products_tenant_isolation" ON "products"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

DROP POLICY IF EXISTS "product_attribute_values_tenant_isolation" ON "product_attribute_values";
CREATE POLICY "product_attribute_values_tenant_isolation" ON "product_attribute_values"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

DROP POLICY IF EXISTS "product_history_tenant_isolation" ON "product_history";
CREATE POLICY "product_history_tenant_isolation" ON "product_history"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
