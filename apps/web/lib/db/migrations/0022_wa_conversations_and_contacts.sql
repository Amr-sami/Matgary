-- Phase 4: conversation + contact aggregates.
--
--  wa_contacts — one row per (tenant, branch, phone). Populated from
--    Meta's inbound `contacts[].profile.name` + `wa_id`. Lets the future
--    inbox UI display "Mona Khaled" instead of just "+20 …", and gives
--    us a stable place to attach merchant-side notes/labels later.
--
--  wa_conversations — one row per (tenant, branch, contact). Aggregates
--    over wa_messages: last_message_at, last_message_preview,
--    unread_count, plus the Meta 24-hour customer service window
--    (window_expires_at). Lets us refuse outbound freeform sends when
--    the window is closed (Phase 5 will route those through templates).
--
-- Both tenant-scoped + RLS forced.

-- ─── wa_contacts ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "wa_contacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "branch_id" uuid NOT NULL REFERENCES "branches"("id") ON DELETE CASCADE,
  "phone_number" text NOT NULL, -- normalised, sans '+'
  "wa_id" text, -- Meta's per-installation wa_id
  -- Profile fields. `display_name` is Meta-supplied (from contacts[].
  -- profile.name); `merchant_label` is owner-editable, takes precedence
  -- in the inbox when present.
  "display_name" text,
  "merchant_label" text,
  -- Free-form tag list (comma-separated) for future segmentation work.
  "tags" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "wa_contacts_tenant_branch_phone_uniq"
  ON "wa_contacts" ("tenant_id", "branch_id", "phone_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_contacts_tenant_branch_idx"
  ON "wa_contacts" ("tenant_id", "branch_id");
--> statement-breakpoint
ALTER TABLE "wa_contacts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "wa_contacts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "wa_contacts_tenant_isolation" ON "wa_contacts"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- ─── wa_conversations ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "wa_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "branch_id" uuid NOT NULL REFERENCES "branches"("id") ON DELETE CASCADE,
  "contact_id" uuid NOT NULL REFERENCES "wa_contacts"("id") ON DELETE CASCADE,
  -- Denormalised for indexing — same value as wa_contacts.phone_number.
  -- Keeping it here avoids a join on every list page.
  "phone_number" text NOT NULL,

  -- Activity summary.
  "last_message_at" timestamp with time zone,
  "last_message_preview" text,
  "last_message_direction" text, -- 'inbound' | 'outbound'
  "unread_count" integer NOT NULL DEFAULT 0,

  -- Meta 24-hour customer-service window. NULL when the customer has
  -- never messaged us (must send via template). Set to inbound.ts+24h
  -- on every inbound message; outbound activity does NOT reset it.
  "window_expires_at" timestamp with time zone,

  -- Snapshot from the most recent status update — for the future
  -- analytics rollup of conversation pricing.
  "last_conversation_id" text,
  "last_conversation_category" text,

  -- Soft-delete / archive flag. Doesn't affect messages.
  "archived_at" timestamp with time zone,

  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "wa_conversations_tenant_branch_contact_uniq"
  ON "wa_conversations" ("tenant_id", "branch_id", "contact_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_conversations_tenant_branch_last_idx"
  ON "wa_conversations" ("tenant_id", "branch_id", "last_message_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_conversations_unread_idx"
  ON "wa_conversations" ("tenant_id", "branch_id", "unread_count")
  WHERE "unread_count" > 0;
--> statement-breakpoint
ALTER TABLE "wa_conversations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "wa_conversations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "wa_conversations_tenant_isolation" ON "wa_conversations"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- Backfill helper: optional FK from wa_messages to wa_conversations so
-- we can paginate messages by conversation efficiently. Nullable
-- because existing rows (before Phase 4) won't have one — the
-- application will populate going forward and a Phase 5 backfill job
-- can fill historicals.
ALTER TABLE "wa_messages"
  ADD COLUMN IF NOT EXISTS "conversation_row_id" uuid
  REFERENCES "wa_conversations"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_messages_conversation_idx"
  ON "wa_messages" ("conversation_row_id", "created_at" DESC);
