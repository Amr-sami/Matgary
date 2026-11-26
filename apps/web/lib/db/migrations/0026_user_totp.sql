-- H03 — 2FA for owners. Adds TOTP secret + recovery code storage to `users`.
-- All three columns are nullable; an account with 2FA off has them all NULL.
-- See specs/hard/H03-2fa.md for the full feature design.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "totp_secret"          text,
  ADD COLUMN IF NOT EXISTS "totp_enabled_at"      timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "recovery_codes_hash"  text[];
