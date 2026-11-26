-- Tier 3: tasks, leave requests, notifications.
-- Plus: recurring expenses (alter expenses), and recorded_by_user_id on sales
-- (for staff performance dashboard).

CREATE TABLE IF NOT EXISTS "tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "assigned_to_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "title" text NOT NULL,
  "description" text,
  "status" text NOT NULL DEFAULT 'open' CHECK ("status" IN ('open','in_progress','done','cancelled')),
  "priority" text NOT NULL DEFAULT 'normal' CHECK ("priority" IN ('low','normal','high')),
  "due_date" timestamptz,
  "completed_at" timestamptz,
  "assignee_seen_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_tenant_assignee_idx"
  ON "tasks" ("tenant_id", "assigned_to_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_tenant_status_idx"
  ON "tasks" ("tenant_id", "status");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "leave_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "start_date" timestamptz NOT NULL,
  "end_date" timestamptz NOT NULL,
  "reason" text,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','approved','rejected')),
  "decided_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamptz,
  "decision_note" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leave_requests_tenant_user_idx"
  ON "leave_requests" ("tenant_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leave_requests_tenant_status_idx"
  ON "leave_requests" ("tenant_id", "status");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "link" text,
  "is_read" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_tenant_user_idx"
  ON "notifications" ("tenant_id", "user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_tenant_user_unread_idx"
  ON "notifications" ("tenant_id", "user_id", "is_read");
--> statement-breakpoint

-- Recurring expense fields.
ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "is_recurring" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "recurrence_period" text
    CHECK ("recurrence_period" IS NULL OR "recurrence_period" IN ('monthly','weekly')),
  ADD COLUMN IF NOT EXISTS "next_occurrence_date" timestamptz,
  ADD COLUMN IF NOT EXISTS "parent_expense_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expenses_tenant_recurring_idx"
  ON "expenses" ("tenant_id", "is_recurring", "next_occurrence_date");
--> statement-breakpoint

-- Cashier attribution on sales (for staff performance leaderboard).
ALTER TABLE "sales"
  ADD COLUMN IF NOT EXISTS "recorded_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_tenant_recorded_by_idx"
  ON "sales" ("tenant_id", "recorded_by_user_id");
--> statement-breakpoint

-- RLS policies — tenant isolation via app.tenant_id GUC, mirroring earlier migrations.
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tasks_tenant_isolation" ON "tasks"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "leave_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "leave_requests_tenant_isolation" ON "leave_requests"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "notifications_tenant_isolation" ON "notifications"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
