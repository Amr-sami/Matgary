-- Phase 2 — Real-time presence + install analytics.
--
-- ONE new table (bounded, one row per web user), plus a performance index on
-- the existing auth_devices.last_used_at column that the heartbeat hook
-- updates. No activity-history table — we read historic DAU/WAU/MAU from
-- the existing activity_logs. No branch columns.
--
-- web_live_sessions is deliberately keyed on user_id (NOT session_token) so
-- a single row per user is enough for presence counts. A user with two
-- browsers open is still one "online web user"; the Overview headline wants
-- distinct users, not distinct cookies. CASCADE on users.id handles cleanup
-- when an account is deleted; a periodic sweep removes rows whose
-- last_activity_at is older than 24h.

CREATE TABLE IF NOT EXISTS "web_live_sessions" (
    "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
    "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
    -- 'web' for a recognized browser UA, 'other' for anything the parser
    -- cannot classify. Never used for authorization — analytics only.
    "platform" text NOT NULL DEFAULT 'web',
    -- Truncated UA string, ≤255 chars, kept only for debugging — we never
    -- surface it to admins; aggregated counts are the product.
    "user_agent" text,
    "last_activity_at" timestamp with time zone NOT NULL DEFAULT now(),
    "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Presence window queries filter by last_activity_at + group by tenant_id
-- or platform; these two indexes cover both access patterns.
CREATE INDEX IF NOT EXISTS "web_live_sessions_tenant_idx"
    ON "web_live_sessions" ("tenant_id", "last_activity_at" DESC);

CREATE INDEX IF NOT EXISTS "web_live_sessions_activity_idx"
    ON "web_live_sessions" ("last_activity_at" DESC);

-- Mobile presence lives in the existing auth_devices.last_used_at (schema
-- already defined; column already exists; just never written to). Add the
-- index that makes "online now" + per-platform aggregates O(log n).
CREATE INDEX IF NOT EXISTS "auth_devices_last_used_idx"
    ON "auth_devices" ("last_used_at" DESC)
    WHERE revoked_at IS NULL;

-- Tenant-scoped install-trend query: "new devices per day for the last 90
-- days, filtered by plan tier through a join to tenants/subscriptions"
-- benefits from an index on (tenant_id, created_at).
CREATE INDEX IF NOT EXISTS "auth_devices_tenant_created_idx"
    ON "auth_devices" ("tenant_id", "created_at" DESC)
    WHERE revoked_at IS NULL;
