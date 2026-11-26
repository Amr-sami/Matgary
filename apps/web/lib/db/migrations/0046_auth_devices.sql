-- Native-client refresh tokens, one row per device.
--
-- Why a table at all, when the web session is stateless: `users.token_version`
-- is per-USER, so the only revocation it can express is "sign out everywhere".
-- A lost phone needs "sign out THAT device", which requires per-device state.
--
-- Only the SHA-256 of the refresh token is stored. A database leak therefore
-- yields no usable credential — the plaintext is returned to the client once,
-- at mint time, and never again.
--
-- Deliberately NOT under RLS. Like `users`, `accounts` and `sessions`, this is
-- authentication bootstrap: it is read before a tenant context exists, so a
-- tenant-scoped policy could never match. Every query filters on user_id, and
-- the token hash is the capability.

CREATE TABLE IF NOT EXISTS auth_devices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- SHA-256 hex of the refresh token. Unique so a replayed mint cannot create
  -- two live rows for one secret.
  refresh_token_hash TEXT NOT NULL UNIQUE,

  -- Client-supplied, for the "your devices" screen. Never trusted for auth.
  device_name       TEXT,
  platform          TEXT,
  app_version       TEXT,
  -- Stable per install. Lets a reinstall replace its old row instead of
  -- accumulating orphans the user cannot identify.
  install_id        TEXT,

  -- Rotation lineage. On refresh the old row is revoked and a new one points
  -- back at it, so presenting an already-rotated token is detectable: that is
  -- token reuse, and it means the secret leaked.
  replaced_by_id    UUID REFERENCES auth_devices(id) ON DELETE SET NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  revoked_reason    TEXT
);

-- The hot path: look a token up by hash, then confirm it is live.
CREATE INDEX IF NOT EXISTS auth_devices_user_idx
  ON auth_devices (user_id) WHERE revoked_at IS NULL;

-- The "my devices" list, newest first.
CREATE INDEX IF NOT EXISTS auth_devices_user_created_idx
  ON auth_devices (user_id, created_at DESC);

-- One live row per (user, install). A reinstall reuses its install_id and the
-- upsert replaces the previous row rather than leaving a second live session.
CREATE UNIQUE INDEX IF NOT EXISTS auth_devices_user_install_live_idx
  ON auth_devices (user_id, install_id)
  WHERE revoked_at IS NULL AND install_id IS NOT NULL;

-- Expired rows are dead weight; the existing cron can sweep them.
CREATE INDEX IF NOT EXISTS auth_devices_expiry_idx
  ON auth_devices (expires_at) WHERE revoked_at IS NULL;
