-- Per-user notification preferences. One row per (tenant, user, event_type)
-- controls how a given event reaches that user: in-app row, email, or both;
-- and whether the email is instant or aggregated into a daily digest.
--
-- A missing row means "use the code default" for that (role, event) pair —
-- see lib/notifications/event-types.ts. We only insert rows the user
-- actually flips away from the default, which keeps the table thin and
-- means we don't need to backfill on new-event rollout.

CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id"     UUID NOT NULL REFERENCES "users"("id")   ON DELETE CASCADE,
  "event_type"  TEXT NOT NULL,
  "in_app"      BOOLEAN NOT NULL DEFAULT true,
  "email"       BOOLEAN NOT NULL DEFAULT false,
  -- 'instant' fires an email per event. 'digest' buffers to
  -- notification_digest_queue and sends one aggregated email per day.
  "digest_mode" TEXT NOT NULL DEFAULT 'instant'
    CHECK ("digest_mode" IN ('instant', 'digest')),
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "notification_preferences_uniq"
    UNIQUE ("tenant_id", "user_id", "event_type")
);

CREATE INDEX IF NOT EXISTS "notification_preferences_tenant_event_idx"
  ON "notification_preferences" ("tenant_id", "event_type");

ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notification_preferences_tenant_isolation" ON "notification_preferences"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
