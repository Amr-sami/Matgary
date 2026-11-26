-- 0069 — Notification Center & Automation
--
-- Three new tables. No changes to existing notification_preferences or
-- notifications — this migration is strictly additive. The dispatcher's
-- new 3-level resolver (user pref → tenant override → system default)
-- reads tenant_notification_overrides. reports-tick reads
-- tenant_report_settings for configurable report cadence.
-- employee_schedules powers the attendance.late sweep (N2).

-- ─── tenant_notification_overrides ───────────────────────────────────────
-- Per-tenant enable/disable for an event type. Resolution order:
--   1) notification_preferences row for (tenant, user, event)      → user override
--   2) tenant_notification_overrides for (tenant, event)           → tenant override
--   3) DEFAULT_EVENT_PREFERENCE[role][event] in event-types.ts     → system default
-- A tenant override of enabled=false forces inApp=off + push=off + email=off
-- for every member on that event. The owner can still re-enable at the
-- user level if desired (user pref wins).
CREATE TABLE IF NOT EXISTS tenant_notification_overrides (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type          text NOT NULL,
  enabled             boolean NOT NULL,
  updated_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_notification_overrides_tenant_event_unique
    UNIQUE (tenant_id, event_type)
);

CREATE INDEX IF NOT EXISTS tenant_notification_overrides_tenant_idx
  ON tenant_notification_overrides (tenant_id);

-- ─── tenant_report_settings ──────────────────────────────────────────────
-- Per-tenant configuration for the daily/weekly/monthly scheduled reports.
-- reports-tick (every 15 min) reads this + tenants.timezone to decide which
-- reports to fire at any given tick. Defaults match the owner's expected
-- behavior ("on by default" per Notification Center spec).
CREATE TABLE IF NOT EXISTS tenant_report_settings (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  daily_enabled    boolean NOT NULL DEFAULT true,
  daily_hour       integer NOT NULL DEFAULT 21,  -- 21:00 local
  daily_minute     integer NOT NULL DEFAULT 0,
  weekly_enabled   boolean NOT NULL DEFAULT true,
  weekly_dow       integer NOT NULL DEFAULT 0,   -- 0=Sun … 6=Sat
  weekly_hour      integer NOT NULL DEFAULT 9,
  weekly_minute    integer NOT NULL DEFAULT 0,
  monthly_enabled  boolean NOT NULL DEFAULT true,
  monthly_day      integer NOT NULL DEFAULT 1,   -- 1..28 (safe across every month)
  monthly_hour     integer NOT NULL DEFAULT 9,
  monthly_minute   integer NOT NULL DEFAULT 0,
  recipients       uuid[] NOT NULL DEFAULT '{}', -- empty = all owners; otherwise explicit user ids
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Sanity bounds so a bad PATCH can't produce an impossible schedule.
  CONSTRAINT tenant_report_settings_hour_bounds CHECK (
    daily_hour BETWEEN 0 AND 23 AND
    daily_minute BETWEEN 0 AND 59 AND
    weekly_hour BETWEEN 0 AND 23 AND
    weekly_minute BETWEEN 0 AND 59 AND
    monthly_hour BETWEEN 0 AND 23 AND
    monthly_minute BETWEEN 0 AND 59
  ),
  CONSTRAINT tenant_report_settings_day_bounds CHECK (
    weekly_dow BETWEEN 0 AND 6 AND
    monthly_day BETWEEN 1 AND 28
  )
);

-- ─── employee_schedules ──────────────────────────────────────────────────
-- Attendance scheduling, kept deliberately OUT of employee_compensation —
-- schedule is an attendance concept, compensation is a payroll concept.
-- One row per employee (uniqueness enforced). grace_minutes = -1 sentinel
-- means "inherit tenant default from attendance_settings.grace_minutes_late"
-- (avoids rewriting every row when the tenant default changes).
-- Powers the attendance.late sweep landing in N2.
CREATE TABLE IF NOT EXISTS employee_schedules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shift_start        time NOT NULL,
  shift_end          time NOT NULL,
  -- Bitmask: bit 0 = Sunday, bit 1 = Monday, … bit 6 = Saturday.
  -- Default 125 = 0b1111101 = Sat + Thu + Wed + Tue + Mon + Sun (Egyptian
  -- 6-day week with Friday off). The owner can override per employee.
  work_days          smallint NOT NULL DEFAULT 125,
  -- -1 means "use tenant default" (attendance_settings.grace_minutes_late).
  -- Otherwise explicit override in minutes.
  grace_minutes      integer NOT NULL DEFAULT -1,
  enabled            boolean NOT NULL DEFAULT true,
  -- Rare: an employee working in a different zone than the tenant. Null
  -- normally; when set, late detection uses this instead of tenants.timezone.
  timezone_override  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_schedules_tenant_user_unique UNIQUE (tenant_id, user_id),
  CONSTRAINT employee_schedules_work_days_bounds CHECK (work_days BETWEEN 0 AND 127),
  CONSTRAINT employee_schedules_grace_bounds CHECK (grace_minutes BETWEEN -1 AND 240)
);

CREATE INDEX IF NOT EXISTS employee_schedules_tenant_idx
  ON employee_schedules (tenant_id);
