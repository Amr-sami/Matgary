-- Expo push tokens, one row per (device install, user).
--
-- The mobile app registers its `ExponentPushToken[...]` after login and the
-- server fans a push out to every ACTIVE token a notification's recipient
-- owns (lib/push/notify.ts). Tokens are pruned, not deleted: Expo's
-- `DeviceNotRegistered` ticket flips `disabled_at`, as does DELETE
-- /api/v1/devices/push-token and logout with a `pushToken` in the body.
--
-- `expo_token` is globally unique: one physical install has exactly one Expo
-- token, so when that token shows up under another user (shared tablet, a
-- staff member signs out and the owner signs in) the row is RE-OWNED by the
-- new caller rather than duplicated — otherwise the previous user's
-- notifications would keep landing on a phone they no longer hold.
--
-- Under RLS like the other tenant tables (see 0044). The fan-out always runs
-- inside `withTenant`, so the policy always has a tenant to match.

CREATE TABLE IF NOT EXISTS "push_tokens" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"    UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id"      UUID NOT NULL REFERENCES "users"("id")   ON DELETE CASCADE,
  "expo_token"   TEXT NOT NULL UNIQUE,
  "platform"     TEXT NOT NULL CHECK ("platform" IN ('ios', 'android')),
  -- Client-supplied label for a future "your devices" list. Never trusted.
  "device_name"  TEXT,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Bumped on every register call so stale rows can be swept later.
  "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Non-null means "do not send". Set by DeviceNotRegistered, DELETE, logout.
  "disabled_at"  TIMESTAMPTZ
);

-- The fan-out hot path: every live token for one recipient.
CREATE INDEX IF NOT EXISTS "push_tokens_tenant_user_live_idx"
  ON "push_tokens" ("tenant_id", "user_id")
  WHERE "disabled_at" IS NULL;

ALTER TABLE "push_tokens" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "push_tokens_tenant_isolation" ON "push_tokens"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Re-own a token that currently sits under ANOTHER tenant.
--
-- The plain upsert in the route runs under RLS, so it can update a row in the
-- caller's own tenant but not one a different shop registered from the same
-- phone. That row must still be taken over — otherwise the other shop keeps
-- pushing to a device its user no longer holds. This function is the one
-- deliberately RLS-blind statement in the feature: owned by the migration
-- role, SECURITY DEFINER, touching exactly one row keyed by the unique token,
-- and only ever called with a server-derived (tenant_id, user_id).
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
        device_name  = EXCLUDED.device_name,
        last_seen_at = now(),
        disabled_at  = NULL;
$$;

REVOKE ALL ON FUNCTION push_token_reown(TEXT, UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION push_token_reown(TEXT, UUID, UUID, TEXT, TEXT) TO matgary_app;
