-- Enable Row-Level Security on shop_settings as defense-in-depth.
-- Application code is still expected to filter by tenant_id explicitly;
-- this is the safety net.

ALTER TABLE "shop_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shop_settings" FORCE ROW LEVEL SECURITY;

CREATE POLICY "shop_settings_tenant_isolation" ON "shop_settings"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
