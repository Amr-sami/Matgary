-- H12 — 30-day grace tenant deletion. Adds a schedule column on `tenants`
-- and a gravestone audit table that outlives the tenant row.

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "deletion_scheduled_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "tenant_deletions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "tenant_slug_snapshot" text NOT NULL,
  "owner_email_snapshot" text,
  "scheduled_at" timestamp with time zone NOT NULL,
  "deleted_at" timestamp with time zone NOT NULL DEFAULT now(),
  "reason" text
);
