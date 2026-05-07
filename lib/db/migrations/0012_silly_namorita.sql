-- Activity log: one row per non-trivial mutation. Tenant-scoped, RLS-protected.
-- Inserts go through logActivity() in lib/repo/activity.ts which swallows errors,
-- so an audit failure never breaks the parent mutation.

CREATE TABLE IF NOT EXISTS "activity_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "actor_name" text,
  "action" text NOT NULL,
  "category" text NOT NULL,
  "entity_type" text,
  "entity_id" uuid,
  "entity_label" text,
  "metadata" jsonb,
  "ip" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_logs_tenant_created_idx"
  ON "activity_logs" ("tenant_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_logs_tenant_actor_idx"
  ON "activity_logs" ("tenant_id", "actor_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_logs_tenant_category_idx"
  ON "activity_logs" ("tenant_id", "category");
--> statement-breakpoint

-- RLS: tenant isolation via app.tenant_id GUC, mirroring the rest of the schema.
ALTER TABLE "activity_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "activity_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "activity_logs_tenant_isolation" ON "activity_logs"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
