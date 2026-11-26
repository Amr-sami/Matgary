-- Phase 2: durable webhook event store + normalised messages table.
--
-- Two tables, distinct security models:
--
--  wa_webhook_events — internal audit log of every webhook delivery from
--    Meta. Persisted BEFORE processing so retries from Meta dedupe by
--    provider_event_id and so the processing pipeline is reentrant.
--    tenant_id is NULLABLE — events that arrive for a phone_number_id
--    we don't recognise are stored with tenant_id=NULL and
--    processing_status='quarantined' for inspection rather than dropped.
--    Because this table mixes tenants (and quarantined null-tenant rows),
--    RLS is NOT enabled here — reads must go through the admin endpoint
--    which gates on owner role + tenant_id filter at the app layer.
--
--  wa_messages — normalised inbound + outbound messages, tenant-scoped.
--    RLS forced with the standard NULLIF guard. WAMID (meta_message_id)
--    is the natural key for status updates.
--
-- Provider-agnostic: `provider` column on both tables defaults to
-- 'meta_cloud' so a future SMS or alternate-WhatsApp provider plugs in
-- without another migration.

-- ─────────────────────────────────────────────────────────────────────────
-- wa_webhook_events
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "wa_webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  "provider" text NOT NULL DEFAULT 'meta_cloud',
  -- Stable per-logical-event idempotency key. Schemes:
  --   msg:<wamid>            inbound message
  --   status:<wamid>:<state> outbound status transition (sent/delivered/read/failed)
  --   change:<sha1>          fallback for change kinds we don't yet decode
  "provider_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  -- 'message.received' | 'message.status' | 'unknown'

  -- Tenant routing. NULL = unresolved (quarantined). FKs use ON DELETE
  -- SET NULL so we keep the audit row when a tenant/branch/connection is
  -- removed downstream.
  "tenant_id" uuid REFERENCES "tenants"("id") ON DELETE SET NULL,
  "branch_id" uuid REFERENCES "branches"("id") ON DELETE SET NULL,
  "connection_id" uuid REFERENCES "wa_connections"("id") ON DELETE SET NULL,

  -- Original routing keys preserved so quarantined rows can be re-routed
  -- later if the connection is re-established.
  "phone_number_id" text,
  "waba_id" text,

  -- The slice of the webhook we processed (single message or single
  -- status), NOT the whole batch — keeps rows small and lets the
  -- idempotency key be one-to-one with the payload.
  "payload" jsonb NOT NULL,

  -- Processing state machine.
  --   pending      -> not yet touched
  --   processing   -> a worker has it (advisory; lock not enforced yet)
  --   processed    -> success
  --   failed       -> retryable failure, retry_count advanced
  --   quarantined  -> tenant resolution failed; needs admin review
  --   dead_letter  -> terminal failure (malformed, etc.)
  "processing_status" text NOT NULL DEFAULT 'pending',
  "retry_count" integer NOT NULL DEFAULT 0,
  "last_attempt_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone,
  "error_details" text,

  "received_at" timestamp with time zone NOT NULL DEFAULT now(),
  "processed_at" timestamp with time zone,

  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Idempotency: same (provider, provider_event_id) can only land once.
-- ON CONFLICT DO NOTHING in code relies on this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS "wa_webhook_events_provider_event_uniq"
  ON "wa_webhook_events" ("provider", "provider_event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_webhook_events_tenant_idx"
  ON "wa_webhook_events" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_webhook_events_status_idx"
  ON "wa_webhook_events" ("processing_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_webhook_events_received_at_idx"
  ON "wa_webhook_events" ("received_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_webhook_events_phone_idx"
  ON "wa_webhook_events" ("phone_number_id");
--> statement-breakpoint
-- Partial index over rows that need worker attention (small + hot).
CREATE INDEX IF NOT EXISTS "wa_webhook_events_pending_idx"
  ON "wa_webhook_events" ("processing_status", "next_attempt_at")
  WHERE "processing_status" IN ('pending', 'failed');
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- wa_messages
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "wa_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "branch_id" uuid NOT NULL REFERENCES "branches"("id") ON DELETE CASCADE,
  "connection_id" uuid REFERENCES "wa_connections"("id") ON DELETE SET NULL,

  "provider" text NOT NULL DEFAULT 'meta_cloud',
  "direction" text NOT NULL, -- 'inbound' | 'outbound'

  -- WAMID — Meta's stable per-message identifier. NULL for outbound rows
  -- still in 'queued' state (not yet sent). Unique once present.
  "meta_message_id" text,
  -- Our own UUID assigned at queue time. Lets us correlate a status
  -- webhook back to the outbound row even if WAMID arrives later.
  "client_message_id" text,

  -- Counterparty (the customer's phone) — stored both normalised and as
  -- the raw wa_id Meta gives us in case they differ (number-porting).
  "contact_phone_number" text NOT NULL,
  "contact_wa_id" text,

  -- Content. message_type extensible; payload jsonb captures the
  -- normalised content shape so we don't need a schema migration for
  -- every new Meta message type.
  "message_type" text NOT NULL,
  -- 'text' | 'document' | 'image' | 'video' | 'audio' | 'sticker' |
  -- 'location' | 'contacts' | 'button_reply' | 'interactive_reply' |
  -- 'reaction' | 'template' | 'unknown'
  "text_body" text,
  "media_id" text,
  "media_mime_type" text,
  "media_filename" text,
  "media_sha256" text,
  "payload" jsonb,

  -- Outbound status lifecycle. Status transitions are append-only on
  -- timestamps (we don't overwrite delivered_at if a 'sent' webhook
  -- arrives late). 'failed' is terminal.
  "status" text,
  -- 'queued' | 'sent' | 'delivered' | 'read' | 'failed'
  "sent_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "read_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "failure_reason" text,
  "failure_code" integer,

  -- Inbound only.
  "received_at" timestamp with time zone,

  -- Meta billing / category metadata for analytics + cost attribution.
  "conversation_id" text,
  "conversation_category" text, -- 'authentication' | 'utility' | 'marketing' | 'service'
  "conversation_origin" text,
  "pricing_category" text,
  "pricing_model" text,
  "pricing_billable" boolean,

  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- WAMID uniqueness across the provider scope. Partial index because
-- queued outbound rows haven't been assigned a WAMID yet.
CREATE UNIQUE INDEX IF NOT EXISTS "wa_messages_meta_message_id_uniq"
  ON "wa_messages" ("provider", "meta_message_id")
  WHERE "meta_message_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wa_messages_client_message_id_uniq"
  ON "wa_messages" ("tenant_id", "client_message_id")
  WHERE "client_message_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_messages_tenant_branch_idx"
  ON "wa_messages" ("tenant_id", "branch_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_messages_contact_idx"
  ON "wa_messages" ("tenant_id", "branch_id", "contact_phone_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_messages_status_idx"
  ON "wa_messages" ("tenant_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_messages_received_at_idx"
  ON "wa_messages" ("tenant_id", "received_at" DESC);
--> statement-breakpoint

-- RLS on wa_messages — standard tenant isolation. wa_webhook_events
-- intentionally has no RLS (internal admin-only audit table; cross-tenant
-- reads are needed for the inspection endpoint that lists quarantined
-- rows).
ALTER TABLE "wa_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "wa_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "wa_messages_tenant_isolation" ON "wa_messages"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
