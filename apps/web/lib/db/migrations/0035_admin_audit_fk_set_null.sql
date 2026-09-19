-- Spec 05 — when an admin is hard-deleted from the admins table, their
-- prior audit log entries must survive. The original FK was ON DELETE
-- RESTRICT which prevents the parent delete. Flip to ON DELETE SET NULL +
-- make the column nullable so historical rows persist with admin_id=NULL
-- (UI shows "(deleted)" for those actor cells).

ALTER TABLE "admin_audit_log"
  ALTER COLUMN "admin_id" DROP NOT NULL;
--> statement-breakpoint

-- Drop both names: the raw-SQL constraint from 0034 lands as the
-- pg-auto-generated name `_admin_id_fkey`, while drizzle-kit when run
-- on the schema definition lands as `_admin_id_admins_id_fk`. Drop both
-- so fresh installs and existing databases both end up with one
-- canonical SET NULL constraint after this migration.
ALTER TABLE "admin_audit_log"
  DROP CONSTRAINT IF EXISTS "admin_audit_log_admin_id_fkey";
--> statement-breakpoint

ALTER TABLE "admin_audit_log"
  DROP CONSTRAINT IF EXISTS "admin_audit_log_admin_id_admins_id_fk";
--> statement-breakpoint

ALTER TABLE "admin_audit_log"
  ADD CONSTRAINT "admin_audit_log_admin_id_admins_id_fk"
  FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE SET NULL;
--> statement-breakpoint
