-- AI pending write actions — the server-side truth for every destructive AI
-- operation BEFORE the user confirms it. F-plan §22: client never supplies the
-- parameters at execute time; the server re-reads this row by id, verifies the
-- HMAC, atomically marks consumed, then executes.
--
-- Why a dedicated table instead of Redis:
--   • Redis is optional in this repo (REDIS_URL may be null in dev).
--   • The pending action needs to be queryable for audit forensics ("what did
--     the model propose that the user cancelled?") — a rare but useful signal.
--   • Atomic one-time-use via UPDATE ... RETURNING on `consumed_at` is a
--     primitive Postgres gives us for free; replicating the same guarantee in
--     Redis needs a Lua script.

CREATE TABLE IF NOT EXISTS ai_pending_actions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  -- Branch may be null when an owner operates in "all branches" mode AND the
  -- action is branch-agnostic (none today, but kept nullable for the future).
  branch_id       uuid        REFERENCES branches(id)         ON DELETE CASCADE,
  action          text        NOT NULL,
  -- Validated parameters captured at preview time. The executor re-reads the
  -- live target from this payload, but NEVER trusts the current value stored
  -- here — that is only a UI hint.
  params          jsonb       NOT NULL,
  -- Preview we showed the user. Used by the UI only; execution ignores it.
  preview         jsonb       NOT NULL,
  -- HMAC-SHA256(server_secret, id | tenant_id | user_id | branch_id | action | canonical(params) | expires_at).
  -- Stored as hex. Server recomputes and constant-time-compares on consume —
  -- means a row mutated out-of-band fails verification and the action is refused.
  hmac            text        NOT NULL,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- One-time-use is the atomic UPDATE ... WHERE consumed_at IS NULL; the index
-- supports the lookup by (tenant, id) + per-user forensic scans.
CREATE INDEX IF NOT EXISTS ai_pending_actions_tenant_user_idx
  ON ai_pending_actions (tenant_id, user_id, created_at DESC);

-- Housekeeping: expired-and-never-consumed rows can be swept by a nightly job.
CREATE INDEX IF NOT EXISTS ai_pending_actions_expiry_idx
  ON ai_pending_actions (expires_at)
  WHERE consumed_at IS NULL;
