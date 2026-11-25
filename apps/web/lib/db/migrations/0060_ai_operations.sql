-- F10.0 — Reversible AI operations.
--
-- Every AI-executed mutation records one row here with the full before/after
-- state needed to safely restore. Rollback is a NEW operation that cites the
-- original; the audit trail stays immutable.
--
-- `operation_group_id` is for the future (F10.1+) import engine: a single
-- XLSX import of 500 products will produce one group + 500 operation rows,
-- and a single user confirm reverts them all under one logical action.
--
-- Concurrency:
--   • The rollback engine compares live state to `after_state` BEFORE
--     writing. A mismatch → RollbackConflictBlock. We never clobber newer
--     human writes.
--   • `status` marches forward: recorded → rolled_back (or rollback_blocked).
--
-- Dependency protection:
--   • Per-entity-type checks (products inspect sale_items / purchase_items;
--     customers inspect orders) run in `rollback.ts` before mutating.
--
-- Security:
--   • RLS + FORCE RLS tenant-scoped (project convention).
--   • `pending_action_id` links back to the original F5 token row — audit
--     forensics can trace preview → confirm → execute → operation → rollback.

CREATE TABLE IF NOT EXISTS ai_operation_groups (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  branch_id       uuid        REFERENCES branches(id)         ON DELETE CASCADE,
  -- Free-form; e.g. 'import', 'bulk_price_update', 'batch'.
  group_type      text        NOT NULL,
  -- The entity family the group affects — used as a UX hint in rollback preview.
  entity_type     text        NOT NULL,
  -- Human-readable label ("Import 2026-11-08 — products.xlsx").
  label           text        NOT NULL,
  -- Lifecycle: created → in_progress → completed | failed | rolled_back | partially_rolled_back.
  status          text        NOT NULL DEFAULT 'created',
  total_operations integer    NOT NULL DEFAULT 0,
  reversed_operations integer NOT NULL DEFAULT 0,
  conflicted_operations integer NOT NULL DEFAULT 0,
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_operation_groups_tenant_idx
  ON ai_operation_groups (tenant_id, created_at DESC);


CREATE TABLE IF NOT EXISTS ai_operations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  branch_id       uuid        REFERENCES branches(id)         ON DELETE CASCADE,
  conversation_id uuid,
  -- Stable identifier for the operation class — matches the audit action code.
  --   'product.price.update' | 'product.quantity.update' |
  --   'product.quantity.adjust' | 'customer.create' | future types…
  operation_type  text        NOT NULL,
  -- Points at ai_pending_actions.id so audit forensics can walk back to the
  -- original token (and inspect the preview that was shown to the user).
  pending_action_id uuid      REFERENCES ai_pending_actions(id) ON DELETE SET NULL,
  -- Optional membership in a group — NULL for single-record writes.
  operation_group_id uuid     REFERENCES ai_operation_groups(id) ON DELETE SET NULL,
  -- Entity the operation mutated. entity_id is NULLable because some entities
  -- (customer_wallets) have composite keys.
  entity_type     text        NOT NULL,
  entity_id       uuid,
  -- Free-text display name ("Musk Rumman", "+2010...").
  entity_label    text        NOT NULL,
  -- Composite key payload for composite-keyed entities (customers). JSON so
  -- additional entities can define their own shape without a migration.
  entity_key      jsonb,
  -- Minimal set of fields we need to restore the before state. The executor
  -- picks what belongs here. e.g. `{"price": 2200}`.
  before_state    jsonb       NOT NULL,
  -- What the executor wrote. Used as the concurrency witness: if the live
  -- value at rollback time differs from after_state, we refuse to clobber.
  after_state     jsonb       NOT NULL,
  -- Names of the fields that actually changed.
  affected_fields text[]      NOT NULL DEFAULT '{}',
  -- False when rollback is not safe at all (e.g. deletion with cascading
  -- constraints). The rollback engine refuses to preview non-reversible ops.
  reversible      boolean     NOT NULL DEFAULT true,
  -- Lifecycle: recorded → rolled_back | rollback_blocked | partially_rolled_back.
  status          text        NOT NULL DEFAULT 'recorded',
  status_reason   text,
  -- Rollback window. NULL → never auto-expires (we keep audit history anyway;
  -- only the rollback capability goes dark).
  expires_at      timestamptz,
  -- When rolled back, points at the rollback's own ai_operations row so you
  -- can walk forward from the original → the undo.
  rollback_operation_id uuid REFERENCES ai_operations(id) ON DELETE SET NULL,
  -- Diagnostic — the actor name at the time of write (not re-resolved on undo).
  actor_name      text,
  -- Idempotency key for de-duplication under retries (used by the F10.1+
  -- import engine). Globally unique inside a tenant so a repeated network
  -- retry can't record a second operation.
  idempotency_key text,
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: one operation per (tenant, idempotency_key) when set.
CREATE UNIQUE INDEX IF NOT EXISTS ai_operations_idempotency_uq
  ON ai_operations (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Primary lookup: user's most-recent reversible op in a conversation.
CREATE INDEX IF NOT EXISTS ai_operations_recent_idx
  ON ai_operations (tenant_id, user_id, conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_operations_group_idx
  ON ai_operations (operation_group_id, created_at);

CREATE INDEX IF NOT EXISTS ai_operations_entity_idx
  ON ai_operations (tenant_id, entity_type, entity_id, created_at DESC);

-- Row-level security — project convention.
ALTER TABLE ai_operation_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_operation_groups FORCE  ROW LEVEL SECURITY;
ALTER TABLE ai_operations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_operations       FORCE  ROW LEVEL SECURITY;

CREATE POLICY ai_operation_groups_tenant_isolation
  ON ai_operation_groups
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY ai_operations_tenant_isolation
  ON ai_operations
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
