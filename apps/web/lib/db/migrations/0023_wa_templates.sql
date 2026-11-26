-- Phase 5: per-tenant cache of WhatsApp message templates.
--
-- Templates live in Meta's WABA-scoped library, but every tenant has
-- their own WABA so the cache is naturally tenant-scoped. We re-fetch
-- via lib/whatsapp/meta-graph.ts:listMessageTemplates and upsert here
-- whenever:
--   - operator clicks "Sync templates" in settings,
--   - a webhook of type `message_template_status_update` arrives
--     (Phase 6 — adds reactive sync),
--   - the daily cron sweep runs (Phase 6+).
--
-- Approved templates can be sent outside the 24-hour customer-service
-- window. The send path reads name + language out of this table at send
-- time so a template that's been paused/rejected upstream stops being
-- usable without code changes.

CREATE TABLE IF NOT EXISTS "wa_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "branch_id" uuid NOT NULL REFERENCES "branches"("id") ON DELETE CASCADE,
  "connection_id" uuid REFERENCES "wa_connections"("id") ON DELETE SET NULL,
  "provider" text NOT NULL DEFAULT 'meta_cloud',

  -- Meta-side identifiers. meta_template_id is Meta's numeric id (we
  -- treat as opaque text); name + language is the actual send-time key.
  "meta_template_id" text,
  "name" text NOT NULL,
  "language" text NOT NULL,

  -- 'authentication' | 'utility' | 'marketing'. UI shows a sandbox/
  -- billing warning for marketing.
  "category" text NOT NULL,

  -- Lifecycle. 'approved' | 'pending' | 'rejected' | 'paused' |
  -- 'in_appeal' | 'pending_deletion' | 'disabled' | 'flagged' | 'stale'.
  -- 'stale' is OUR addition: template existed at last sync but has now
  -- disappeared from Meta's list — we keep the row for forensics but
  -- the send-time lookup filters it out.
  "status" text NOT NULL,

  -- Structural components (header/body/footer/buttons), the actual
  -- template body text, parameter placeholders, etc. Stored verbatim
  -- so the send path can render parameters without re-fetching.
  "components" jsonb NOT NULL,

  -- Optional quality / rejection signals. Meta returns
  -- quality_score.score plus rejection_reason on rejected templates.
  "quality_score" jsonb,
  "rejected_reason" text,

  -- Parameter format: 'POSITIONAL' (default; {{1}}, {{2}}) or 'NAMED'
  -- (the newer variable-name flavour). Read-only metadata.
  "parameter_format" text,

  "last_synced_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- Raw response for debugging. Kept small per-row (templates are tiny).
  "raw_payload" jsonb,

  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- (name, language) is unique within a tenant's branch — Meta enforces
-- this too. Note: same template name can exist in multiple languages.
CREATE UNIQUE INDEX IF NOT EXISTS "wa_templates_branch_name_lang_uniq"
  ON "wa_templates" ("tenant_id", "branch_id", "name", "language");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_templates_tenant_branch_idx"
  ON "wa_templates" ("tenant_id", "branch_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_templates_status_idx"
  ON "wa_templates" ("tenant_id", "status");
--> statement-breakpoint

ALTER TABLE "wa_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "wa_templates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "wa_templates_tenant_isolation" ON "wa_templates"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
