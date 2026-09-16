-- Digest buffer. High-volume events (sales) get enqueued here per recipient
-- when their preference for that event is `email + digest`. The daily cron
-- (app/api/cron/notifications-digest) drains everything with sent_at IS NULL,
-- groups by user, sends one summary email per user, and stamps sent_at.
--
-- Kept as a plain queue table (not a materialized view) so we can retry
-- partial failures per row and audit exactly what was sent.

CREATE TABLE IF NOT EXISTS "notification_digest_queue" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id"     UUID NOT NULL REFERENCES "users"("id")   ON DELETE CASCADE,
  "event_type"  TEXT NOT NULL,
  "payload"     JSONB NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "sent_at"     TIMESTAMPTZ
);

-- Cron scans WHERE sent_at IS NULL — partial index keeps it fast even after
-- the queue grows to millions of historical rows.
CREATE INDEX IF NOT EXISTS "notification_digest_queue_pending_idx"
  ON "notification_digest_queue" ("tenant_id", "user_id", "created_at")
  WHERE "sent_at" IS NULL;

ALTER TABLE "notification_digest_queue" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notification_digest_queue_tenant_isolation" ON "notification_digest_queue"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
