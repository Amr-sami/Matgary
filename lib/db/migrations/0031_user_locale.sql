-- Phase 2 of the i18n rollout. Users can sign up in either Arabic or
-- English; we need to remember which so password-reset emails (and any
-- future transactional email) reach them in the right language.
-- Default `ar` matches the current production state — existing users
-- backfill to Arabic, which is what they got before this column existed.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "locale" text NOT NULL DEFAULT 'ar';

-- Lock down to the locales the dictionary actually has, so a stray
-- update can't write "fr" or similar and break the email-template lookup.
-- Idempotent: Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so guard
-- via pg_constraint catalogue so the migrator can re-run cleanly on
-- envs where this was previously applied by hand (dev DBs that ran the
-- SQL via psql before the journal entry existed — see F-01 in
-- docs/specs/security-review-validation.md).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_locale_chk'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_locale_chk" CHECK ("locale" IN ('ar', 'en'));
  END IF;
END $$;
