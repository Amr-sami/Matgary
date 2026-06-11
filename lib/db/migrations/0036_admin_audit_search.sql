-- Spec 08 — searchable admin audit log. The viewer at /admin/audit lets
-- admins free-text search across the union of before+after JSONB diffs.
-- pg_trgm is the only common trigram extension; if it's already installed
-- the migration is a no-op.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- GIN over the concatenated text projection of before+after JSONB columns.
-- LIKE-able lookups; cheap enough to maintain at the scale this table runs
-- at (a few hundred to a few thousand rows over the typical retention
-- window).
CREATE INDEX IF NOT EXISTS "admin_audit_diff_gin_idx"
  ON "admin_audit_log"
  USING GIN ((coalesce("before_jsonb"::text, '') || ' ' || coalesce("after_jsonb"::text, '')) gin_trgm_ops);
--> statement-breakpoint
