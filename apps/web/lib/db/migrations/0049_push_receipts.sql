-- Push follow-ups (doc 06 §8.2, §8.3): the receipts queue, the per-event
-- push toggle, and a re-own that keeps the device label.
--
-- 1. push_receipts — Expo answers a send with a TICKET, and a ticket-level
--    `DeviceNotRegistered` only appears for tokens Expo already knows are
--    dead. A real uninstall shows up minutes later in the RECEIPT for that
--    ticket (GET /--/api/v2/push/getReceipts). Every `ok` ticket is queued
--    here and the hourly cron drains rows older than 15 minutes, disabling
--    the token when the receipt says DeviceNotRegistered. Rows are deleted
--    once checked (or once 24 h old — Expo keeps receipts for a day).
--
-- 2. notification_preferences.push — "in-app yes, push no" was impossible
--    while `in_app` doubled as the push toggle. The dispatcher already keeps
--    `sale.created` out of push via digest mode; this column is the explicit
--    per-user switch the spec asks for. Default true = today's behaviour.
--
-- 3. push_token_reown — the client re-registers on token rotation and app
--    update (spec §8.5) and may not resend `deviceName`; a NULL must not wipe
--    the stored label. Same fix lives in the route's ON CONFLICT set.

CREATE TABLE IF NOT EXISTS "push_receipts" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"  UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id"    UUID NOT NULL REFERENCES "users"("id")   ON DELETE CASCADE,
  "expo_token" TEXT NOT NULL,
  -- Expo ticket id (a UUID on their side, but opaque to us).
  "ticket_id"  TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The drain: "everything due for this tenant", oldest first.
CREATE INDEX IF NOT EXISTS "push_receipts_tenant_created_idx"
  ON "push_receipts" ("tenant_id", "created_at");

ALTER TABLE "push_receipts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "push_receipts_tenant_isolation" ON "push_receipts"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "notification_preferences"
  ADD COLUMN IF NOT EXISTS "push" BOOLEAN NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION push_token_reown(
  p_token       TEXT,
  p_tenant_id   UUID,
  p_user_id     UUID,
  p_platform    TEXT,
  p_device_name TEXT
) RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO push_tokens (tenant_id, user_id, expo_token, platform, device_name, last_seen_at, disabled_at)
  VALUES (p_tenant_id, p_user_id, p_token, p_platform, p_device_name, now(), NULL)
  ON CONFLICT (expo_token) DO UPDATE
    SET tenant_id    = EXCLUDED.tenant_id,
        user_id      = EXCLUDED.user_id,
        platform     = EXCLUDED.platform,
        device_name  = COALESCE(EXCLUDED.device_name, push_tokens.device_name),
        last_seen_at = now(),
        disabled_at  = NULL;
$$;
