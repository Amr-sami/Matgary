-- Daily owner WhatsApp digest. See docs/specs/daily-owner-digest.md.
--
-- digest_settings: one row per tenant, holds the schedule + recipients.
-- digest_runs:     one row per (tenant, branch, business_date, recipient,
--                  channel) — the idempotency anchor.

CREATE TABLE IF NOT EXISTS "digest_settings" (
  "tenant_id"              uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "enabled"                boolean NOT NULL DEFAULT false,
  -- 0 = midnight (end-of-day digest). Tenant-local timezone (tenants.timezone).
  "digest_hour"            smallint NOT NULL DEFAULT 0
                            CHECK ("digest_hour" BETWEEN 0 AND 23),
  -- Primary recipient phone for the digest. Intentionally NOT tied to
  -- shop_settings.shop_phone (which is the customer-facing receipt number)
  -- nor to tenant_members.phone (employee HR contact). The owner / manager
  -- can put their personal WhatsApp number here without touching the
  -- receipt-sending config.
  "owner_phone"            text,
  "send_on_empty"          boolean NOT NULL DEFAULT false,
  "email_fallback"         boolean NOT NULL DEFAULT true,
  -- shape: [{ name, phone?, email?, locale? }]
  "extra_recipients"       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- user ids of managers who opted in to their branch digest
  "managers_subscribed"    uuid[] NOT NULL DEFAULT '{}'::uuid[],
  "updated_at"             timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE "digest_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "digest_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "digest_settings_tenant_isolation" ON "digest_settings"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "digest_runs" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"             uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "branch_id"             uuid NOT NULL REFERENCES "branches"("id") ON DELETE CASCADE,
  "business_date"         date NOT NULL,
  "recipient_user_id"     uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "recipient_phone"       text,
  "recipient_email"       text,
  "channel"               text NOT NULL
                           CHECK ("channel" IN ('whatsapp', 'email', 'email_fallback')),
  "status"                text NOT NULL DEFAULT 'pending'
                           CHECK ("status" IN ('pending', 'sent', 'failed', 'skipped_empty', 'skipped_no_channel')),
  "error"                 text,
  "payload"               jsonb NOT NULL,
  "message_text"          text,
  "whatsapp_message_id"   text,
  "enqueued_at"           timestamptz NOT NULL DEFAULT now(),
  "sent_at"               timestamptz
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "digest_runs_tenant_date_idx"
  ON "digest_runs" ("tenant_id", "business_date" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "digest_runs_status_idx"
  ON "digest_runs" ("status", "enqueued_at") WHERE "status" = 'pending';
--> statement-breakpoint

-- Idempotency anchors:
--   - For real users: (tenant, branch, day, user, channel) unique.
--   - For phone-only extras: (tenant, branch, day, phone, channel) unique.
CREATE UNIQUE INDEX IF NOT EXISTS "digest_runs_idempotency"
  ON "digest_runs" ("tenant_id", "branch_id", "business_date", "recipient_user_id", "channel")
  WHERE "recipient_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "digest_runs_idempotency_phone"
  ON "digest_runs" ("tenant_id", "branch_id", "business_date", "recipient_phone", "channel")
  WHERE "recipient_user_id" IS NULL AND "recipient_phone" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "digest_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "digest_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "digest_runs_tenant_isolation" ON "digest_runs"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
