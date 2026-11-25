-- F10.1 — AI Data Import Engine.
--
-- `ai_import_sessions` is the durable session state for a conversational
-- import. Status machine:
--   uploaded → parsing → mapping → validating → needs_input
--            → ready_for_preview → awaiting_confirmation → importing
--            → completed | partially_completed | failed | cancelled | expired
--
-- `ai_import_rows` is one row per spreadsheet row. Keeping them in-DB rather
-- than in-memory lets the conversational correction flow (`apply_import_
-- correction`) persist across multiple chat turns + request retries.
--
-- Idempotency: UNIQUE(tenant, file_hash, entity_type) ensures the same file
-- can't accidentally produce two parallel sessions. Re-uploading returns the
-- existing session (status-aware behavior lives in the service layer).
--
-- Tenant isolation: RLS + FORCE RLS; also explicit WHERE tenant_id in every
-- query. Matches the project convention established by prior AI tables.

CREATE TABLE IF NOT EXISTS ai_import_sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  branch_id       uuid        REFERENCES branches(id)         ON DELETE CASCADE,
  conversation_id uuid,
  -- Classification of the top-level entity the session imports — 'product'
  -- for F10.1; future waves add 'customer', 'employee', etc.
  entity_type     text        NOT NULL,
  -- Diagnostic only.
  file_name       text        NOT NULL,
  mime_type       text        NOT NULL,
  file_hash       text        NOT NULL,
  file_size       integer     NOT NULL,
  -- Session lifecycle — see enum above.
  status          text        NOT NULL DEFAULT 'uploaded',
  status_detail   text,
  -- Field mapping the engine computed from the sheet headers. Shape:
  --   { "sku": "Product Code", "price": "سعر البيع", … }
  -- May be updated by `apply_import_correction`.
  field_mapping   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Global corrections that apply to every row (e.g. "set wholesale price to
  -- 2000 for all missing rows"). The executor consults this before importing.
  corrections     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  row_count       integer     NOT NULL DEFAULT 0,
  valid_count     integer     NOT NULL DEFAULT 0,
  invalid_count   integer     NOT NULL DEFAULT 0,
  ambiguous_count integer     NOT NULL DEFAULT 0,
  missing_count   integer     NOT NULL DEFAULT 0,
  -- When importing completes, this points at the ai_operation_groups row that
  -- wraps all row-level operations. Used by F10.0 rollback.
  operation_group_id uuid REFERENCES ai_operation_groups(id) ON DELETE SET NULL,
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Dedupe: same file + same entity type → same session.
CREATE UNIQUE INDEX IF NOT EXISTS ai_import_sessions_dedupe_uq
  ON ai_import_sessions (tenant_id, file_hash, entity_type);

CREATE INDEX IF NOT EXISTS ai_import_sessions_recent_idx
  ON ai_import_sessions (tenant_id, user_id, created_at DESC);


CREATE TABLE IF NOT EXISTS ai_import_rows (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  import_session_id uuid      NOT NULL REFERENCES ai_import_sessions(id) ON DELETE CASCADE,
  -- 1-based row index in the source sheet (after header).
  row_index       integer     NOT NULL,
  -- Row lifecycle: valid | invalid | ambiguous | missing | ready | imported | failed | skipped.
  status          text        NOT NULL,
  -- Operation the engine will apply: create | update | skip | none.
  action          text        NOT NULL DEFAULT 'none',
  -- Raw values as parsed from the sheet (strings keyed by original header).
  raw             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Normalised payload the executor will hand to addProduct/updateProduct.
  normalised      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Entity resolution result (which existing SKU this row would update, etc.).
  resolution      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Per-row errors: [{ field: 'price', code: 'INVALID_NUMBER', message: '…' }].
  errors          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- Per-row notes/ambiguities surfaced to the user for correction.
  issues          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- ai_operations.id written during execute; NULL for rows that were skipped
  -- or failed. Lets group rollback target only successful rows.
  operation_id    uuid        REFERENCES ai_operations(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_import_rows_session_idx
  ON ai_import_rows (import_session_id, row_index);

CREATE INDEX IF NOT EXISTS ai_import_rows_tenant_status_idx
  ON ai_import_rows (tenant_id, import_session_id, status);


ALTER TABLE ai_import_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_import_sessions FORCE  ROW LEVEL SECURITY;
ALTER TABLE ai_import_rows     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_import_rows     FORCE  ROW LEVEL SECURITY;

CREATE POLICY ai_import_sessions_tenant_isolation
  ON ai_import_sessions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY ai_import_rows_tenant_isolation
  ON ai_import_rows
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
