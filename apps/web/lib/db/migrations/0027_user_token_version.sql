-- H09 — session revocation foundation. Adds a monotonic token_version
-- column to `users`; bumping it invalidates every JWT issued before the
-- bump on the next session callback. NOT NULL default 0 so existing
-- session-bearing users keep working with their first-revocation gap
-- being the first bump.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "token_version" integer NOT NULL DEFAULT 0;
