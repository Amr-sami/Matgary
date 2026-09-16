-- Attendance & payroll: per-tenant settings, store geofences, raw event log,
-- versioned compensation, and snapshotted payroll periods.

CREATE TABLE IF NOT EXISTS "attendance_settings" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "work_hours_per_day" numeric(4,2) NOT NULL DEFAULT 8,
  "weekend_days" int[] NOT NULL DEFAULT '{5,6}'::int[],
  "overtime_multiplier" numeric(4,2) NOT NULL DEFAULT 1.0,
  "grace_minutes_late" integer NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "store_locations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "latitude" numeric(9,6) NOT NULL,
  "longitude" numeric(9,6) NOT NULL,
  "geofence_radius_m" integer NOT NULL DEFAULT 50,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "store_locations_tenant_idx" ON "store_locations" ("tenant_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "attendance_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "employee_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "type" text NOT NULL CHECK ("type" IN ('check_in','check_out')),
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "source" text NOT NULL CHECK ("source" IN ('manual','geofence','qr','manager_attest')),
  "latitude" numeric(9,6),
  "longitude" numeric(9,6),
  "accuracy_m" integer,
  "recorded_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "note" text,
  "requires_review" boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attendance_tenant_employee_time_idx"
  ON "attendance_events" ("tenant_id", "employee_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attendance_tenant_time_idx"
  ON "attendance_events" ("tenant_id", "occurred_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "employee_compensation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "employee_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "pay_type" text NOT NULL CHECK ("pay_type" IN ('fixed','hourly','hybrid')),
  "base_salary_monthly" numeric(12,2),
  "hourly_rate" numeric(12,2),
  "standard_monthly_hours" numeric(6,2),
  "effective_from" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "emp_comp_tenant_employee_effective_idx"
  ON "employee_compensation" ("tenant_id", "employee_id", "effective_from");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "payroll_periods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "employee_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL,
  "regular_hours" numeric(8,2) NOT NULL DEFAULT 0,
  "overtime_hours" numeric(8,2) NOT NULL DEFAULT 0,
  "gross_amount" numeric(12,2) NOT NULL DEFAULT 0,
  "adjustments_amount" numeric(12,2) NOT NULL DEFAULT 0,
  "adjustments_note" text,
  "status" text NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft','finalized')),
  "finalized_at" timestamptz,
  "finalized_by_user_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_periods_tenant_employee_period_idx"
  ON "payroll_periods" ("tenant_id", "employee_id", "period_start");
--> statement-breakpoint

-- RLS policies — tenant isolation via app.tenant_id GUC, mirroring 0006.
ALTER TABLE "attendance_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "attendance_settings_tenant_isolation" ON "attendance_settings"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "store_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_locations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "store_locations_tenant_isolation" ON "store_locations"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "attendance_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "attendance_events_tenant_isolation" ON "attendance_events"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "employee_compensation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_compensation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "employee_compensation_tenant_isolation" ON "employee_compensation"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "payroll_periods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_periods" FORCE ROW LEVEL SECURITY;
CREATE POLICY "payroll_periods_tenant_isolation" ON "payroll_periods"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
