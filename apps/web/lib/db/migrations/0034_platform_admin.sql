-- Platform admin foundation. See docs/specs/platform-admin-01-foundation.md.
--
-- One migration lays down every table the entire admin initiative ever needs,
-- plus the suspended_* columns on tenants used by Spec 03. Later sub-specs
-- only USE these tables.
--
-- The bootstrap admin row is NOT inserted here — lib/db/migrate.ts seeds it
-- post-DDL with a runtime-bcrypt'd password so the SQL file never carries a
-- credential.

CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "admins" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email"               citext NOT NULL UNIQUE,
  "password_hash"       text NOT NULL,
  "display_name"        text,
  "role"                text NOT NULL DEFAULT 'ops_admin'
                         CHECK ("role" IN ('super_admin', 'ops_admin')),
  "must_rotate"         boolean NOT NULL DEFAULT false,
  -- 2FA columns reserved for v1.1; null = disabled in v1.
  "totp_secret"         text,
  "totp_enabled_at"     timestamptz,
  "last_login_at"       timestamptz,
  "last_login_ip"       text,
  "failed_attempts"     int NOT NULL DEFAULT 0,
  "locked_until"        timestamptz,
  "disabled_at"         timestamptz,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "created_by_admin_id" uuid REFERENCES "admins"("id") ON DELETE SET NULL,
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "admin_sessions" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "admin_id"        uuid NOT NULL REFERENCES "admins"("id") ON DELETE CASCADE,
  "session_token"   text NOT NULL UNIQUE,
  "ip"              text,
  "user_agent"      text,
  -- Reserved for Spec 07 (impersonation). NULL means normal admin browsing.
  "impersonating_tenant_id" uuid REFERENCES "tenants"("id") ON DELETE SET NULL,
  "impersonating_user_id"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "last_seen_at"    timestamptz NOT NULL DEFAULT now(),
  "expires_at"      timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_sessions_admin_idx" ON "admin_sessions" ("admin_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_sessions_token_idx" ON "admin_sessions" ("session_token");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "admin_password_history" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "admin_id"      uuid NOT NULL REFERENCES "admins"("id") ON DELETE CASCADE,
  "password_hash" text NOT NULL,
  "changed_at"    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_pw_history_admin_idx"
  ON "admin_password_history" ("admin_id", "changed_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "admin_audit_log" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "admin_id"        uuid NOT NULL REFERENCES "admins"("id") ON DELETE RESTRICT,
  "action"          text NOT NULL,
  "target_kind"     text,
  "target_id"       uuid,
  "ip"              text,
  "user_agent"      text,
  "before_jsonb"    jsonb,
  "after_jsonb"     jsonb,
  "occurred_at"     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_admin_time_idx"
  ON "admin_audit_log" ("admin_id", "occurred_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_target_idx"
  ON "admin_audit_log" ("target_kind", "target_id");
--> statement-breakpoint

-- For Spec 04. Created now so the schema only changes once. Migrate script
-- seeds the three rows from lib/payments/plans.ts after DDL.
CREATE TABLE IF NOT EXISTS "platform_plans" (
  "key"            text PRIMARY KEY,
  "label_ar"       text NOT NULL,
  "label_en"       text NOT NULL,
  "tagline_ar"     text NOT NULL,
  "tagline_en"     text NOT NULL,
  "monthly_egp"    int  NOT NULL DEFAULT 0,
  "purchasable"    boolean NOT NULL DEFAULT false,
  "features_ar"    text[] NOT NULL DEFAULT '{}',
  "features_en"    text[] NOT NULL DEFAULT '{}',
  "sort_order"     int NOT NULL DEFAULT 0,
  "updated_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_by_admin_id" uuid REFERENCES "admins"("id") ON DELETE SET NULL
);
--> statement-breakpoint

-- For Spec 06. Created now so the schema only changes once.
CREATE TABLE IF NOT EXISTS "platform_broadcasts" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "title_ar"        text NOT NULL,
  "title_en"        text NOT NULL,
  "body_ar"         text,
  "body_en"         text,
  "severity"        text NOT NULL DEFAULT 'info'
                     CHECK ("severity" IN ('info', 'warning', 'critical')),
  "audience"        text NOT NULL DEFAULT 'all'
                     CHECK ("audience" IN ('all', 'owners', 'staff')),
  "starts_at"       timestamptz NOT NULL DEFAULT now(),
  "ends_at"         timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "created_by_admin_id" uuid REFERENCES "admins"("id") ON DELETE SET NULL
);
--> statement-breakpoint

-- Spec 03 will use these. Added now so the schema only changes once.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "suspended_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "suspended_reason" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenants_suspended_idx"
  ON "tenants" ("suspended_at") WHERE "suspended_at" IS NOT NULL;
--> statement-breakpoint

-- Admin tables sit OUTSIDE the tenant RLS model. They have no tenant_id;
-- access control is enforced at the application layer via admin sessions.
-- The matgary_admin DB role created in migrate.ts has BYPASSRLS so it sees
-- every tenant in one query; matgary_app explicitly does NOT.
