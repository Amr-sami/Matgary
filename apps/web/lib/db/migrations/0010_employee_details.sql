-- Per-tenant employee details: contact info + ID + photo paths.
-- All columns are nullable so existing rows continue working without backfill.

ALTER TABLE "tenant_members"
  ADD COLUMN IF NOT EXISTS "phone" text,
  ADD COLUMN IF NOT EXISTS "national_id" text,
  ADD COLUMN IF NOT EXISTS "address" text,
  ADD COLUMN IF NOT EXISTS "profile_photo_path" text,
  ADD COLUMN IF NOT EXISTS "id_photo_path" text;
