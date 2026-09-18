-- Per-device snapshot of users.token_version.
--
-- "Sign out everywhere" bumps users.token_version. The native refresh route
-- used to learn which version a device session was issued under ONLY from
-- the caller's own access token — a tamper-proof baseline, but an optional
-- one: a device that refreshes after its access token has expired sends no
-- bearer at all, skips the comparison, and survives the sweep. That device
-- is exactly the one a sweep exists for (a handset that has been offline
-- for a while, or is in the wrong hands).
--
-- Storing the version on the row makes the baseline mandatory and server-
-- held: written at login, carried forward on every rotation, compared on
-- every refresh regardless of what the client sends.
--
-- DEFAULT 0 backfills the rows that exist today. users.token_version starts
-- at 0 too, so a session minted before this column lands stays valid until
-- the user's version moves — which is the same behaviour it had before.
ALTER TABLE auth_devices
  ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
