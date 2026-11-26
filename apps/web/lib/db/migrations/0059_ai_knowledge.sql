-- F9 — Knowledge / RAG layer.
--
-- ai_knowledge_documents  — one row per logical document version (versioning
--                           is via distinct rows + `version` + `is_current`;
--                           an archive supersedes by flipping the flag).
-- ai_knowledge_chunks     — the retrievable units. embedding stored as
--                           double precision[] so SQL can compute cosine
--                           similarity without a pgvector extension. The
--                           pg_available_extensions on postgres:16-alpine
--                           doesn't ship pgvector; migrating to pgvector is a
--                           future swap (column-type change + index add).
--
-- Both tables are tenant-isolated at the row level and (when applicable)
-- branch-isolated. Retrieval must always filter at the SQL layer — the LLM
-- never sees anything outside this filter.
--
-- Full-text search: content_tsv is a generated tsvector so ts_rank_cd can
-- participate in hybrid retrieval alongside vector similarity.

CREATE TABLE IF NOT EXISTS ai_knowledge_documents (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id      uuid        REFERENCES branches(id)         ON DELETE CASCADE,
  title          text        NOT NULL,
  description    text,
  -- 'policy' | 'sop' | 'manual' | 'faq' | 'training' | 'product_documentation'
  -- | 'supplier_documentation' | 'other'. Not an enum — adding types later
  -- shouldn't require a migration.
  document_type  text        NOT NULL,
  -- 'upload' | 'seed' | 'api'. Diagnostic only.
  source         text        NOT NULL DEFAULT 'upload',
  file_name      text,
  mime_type      text,
  language       text        NOT NULL DEFAULT 'en', -- ISO 639-1 (ar/en/pt/fr/es).
  version        integer     NOT NULL DEFAULT 1,
  -- Only is_current = true documents participate in retrieval. Flipping to
  -- false archives a document without deleting the audit trail.
  is_current     boolean     NOT NULL DEFAULT true,
  -- 'pending' | 'processing' | 'ready' | 'failed' | 'archived'.
  status         text        NOT NULL DEFAULT 'pending',
  status_detail  text,
  -- SHA-256 of the normalised full-text. Used to skip re-embedding identical
  -- content and to detect duplicates within a tenant.
  content_hash   text,
  metadata       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_knowledge_documents_tenant_idx
  ON ai_knowledge_documents (tenant_id, is_current, status);

CREATE INDEX IF NOT EXISTS ai_knowledge_documents_tenant_branch_idx
  ON ai_knowledge_documents (tenant_id, branch_id, is_current, status);

-- Prevent two concurrent is_current=true rows for (tenant, title) collisions
-- while allowing archived historical versions to live alongside.
CREATE UNIQUE INDEX IF NOT EXISTS ai_knowledge_documents_tenant_title_current_uq
  ON ai_knowledge_documents (tenant_id, title)
  WHERE is_current = true AND status = 'ready';


CREATE TABLE IF NOT EXISTS ai_knowledge_chunks (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id      uuid        REFERENCES branches(id)         ON DELETE CASCADE,
  document_id    uuid        NOT NULL REFERENCES ai_knowledge_documents(id) ON DELETE CASCADE,
  document_version integer   NOT NULL,
  chunk_index    integer     NOT NULL,
  section        text,
  language       text        NOT NULL DEFAULT 'en',
  content        text        NOT NULL,
  -- Generated tsvector for keyword/trigram retrieval. We use 'simple' because
  -- we support Arabic — the 'english' config would stem Latin tokens and
  -- discard Arabic ones entirely. Lower precision on English, but uniform
  -- behaviour across languages.
  content_tsv    tsvector    GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  -- Embedding vector. Dimensionality = 768 (Gemini text-embedding-004).
  -- Stored as float8[] for pgvector-less deployments. Swap to vector(768)
  -- when pgvector lands — one migration + one retrieval SQL rewrite.
  embedding      double precision[] NOT NULL,
  embedding_model text       NOT NULL DEFAULT 'gemini-text-embedding-004',
  token_count    integer     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_tenant_idx
  ON ai_knowledge_chunks (tenant_id);

CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_document_idx
  ON ai_knowledge_chunks (document_id, chunk_index);

CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_tsv_idx
  ON ai_knowledge_chunks USING GIN (content_tsv);

-- Enable RLS to match the rest of the project's tenant-scoped tables. The
-- app role (NOSUPERUSER) sets app.tenant_id via SET LOCAL per transaction;
-- the policy enforces tenant_id matches. See lib/db/with-tenant.ts.
ALTER TABLE ai_knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_knowledge_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_knowledge_chunks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_knowledge_chunks    FORCE ROW LEVEL SECURITY;

CREATE POLICY ai_knowledge_documents_tenant_isolation
  ON ai_knowledge_documents
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY ai_knowledge_chunks_tenant_isolation
  ON ai_knowledge_chunks
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
