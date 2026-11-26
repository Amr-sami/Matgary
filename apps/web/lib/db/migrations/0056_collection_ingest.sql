-- Digital collections, milestone M2: automatic matching from the owner's phone
-- (mobile-dev-docs/15-digital-collections, spec 04; names from 03 §B.2.5-B.2.7).
--
--   collection_ingest_devices  phones allowed to forward bank/wallet messages,
--                              each with its own ingest token (hash only)
--   collection_raw_messages    the forwarded text, encrypted and short-lived
--   collection_credits         one row per real-world credit/debit after dedupe
--
-- collection_ingest_devices is deliberately NOT under RLS, like auth_devices
-- (0046): the ingest token is looked up before the tenant is known, and with
-- FORCE RLS that lookup would return nothing. The token hash is the
-- capability; every other query filters tenant_id explicitly. Never list this
-- table in a "SELECT * under withTenant" export: RLS does not filter it.
--
-- The other two tables get ENABLE + FORCE + "<table>_tenant_isolation".
--
-- Also adds the three FKs 0055 could not declare because their targets did
-- not exist yet: collections.matched_credit_id, collection_events.actor_device_id,
-- collection_events.credit_id (all ON DELETE SET NULL, guarded DO block).
--
-- Additive only; no existing row changes.

CREATE TABLE IF NOT EXISTS "collection_ingest_devices" (
  "id"                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           uuid         NOT NULL REFERENCES "tenants"("id")   ON DELETE CASCADE,
  "branch_id"           uuid         REFERENCES "branches"("id")           ON DELETE RESTRICT,
  "created_by_user_id"  uuid         REFERENCES "users"("id")              ON DELETE SET NULL,
  "label"               text         NOT NULL
    CONSTRAINT "collection_ingest_devices_label_check" CHECK (char_length("label") BETWEEN 1 AND 60),
  "platform"            text         NOT NULL
    CONSTRAINT "collection_ingest_devices_platform_check" CHECK ("platform" IN ('ios_shortcut', 'ios_app_intent', 'android_listener', 'android_collector')),
  "channels"            text[]       NOT NULL
    CONSTRAINT "collection_ingest_devices_channels_check" CHECK (
      cardinality("channels") >= 1
      AND "channels" <@ ARRAY['ios_notification', 'ios_sms', 'android_notification', 'android_sms', 'manual_paste', 'statement']::text[]
    ),
  "account_ids"         uuid[]       NOT NULL DEFAULT '{}'::uuid[],
  "token_hash"          text         NOT NULL
    CONSTRAINT "collection_ingest_devices_token_hash_uq" UNIQUE
    CONSTRAINT "collection_ingest_devices_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  "token_prefix"        text         NOT NULL
    CONSTRAINT "collection_ingest_devices_token_prefix_check" CHECK (char_length("token_prefix") = 8),
  "consent_version"     text         NOT NULL,
  "consent_at"          timestamptz  NOT NULL,
  "consent_user_id"     uuid         REFERENCES "users"("id")              ON DELETE SET NULL,
  "app_version"         text,
  "os_version"          text,
  "last_seen_at"        timestamptz,
  "last_message_at"     timestamptz,
  "last_credit_at"      timestamptz,
  "last_heartbeat"      jsonb,
  "silent_alerted_at"   timestamptz,
  "revoked_at"          timestamptz,
  "revoked_by_user_id"  uuid         REFERENCES "users"("id")              ON DELETE SET NULL,
  "revoked_reason"      text
    CONSTRAINT "collection_ingest_devices_revoked_reason_check" CHECK ("revoked_reason" IN ('owner', 'user_removed', 'security', 'replaced')),
  "created_at"          timestamptz  NOT NULL DEFAULT now(),
  "updated_at"          timestamptz  NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_ingest_devices_tenant_live_idx"
  ON "collection_ingest_devices" ("tenant_id")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collection_raw_messages" (
  "id"                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           uuid         NOT NULL REFERENCES "tenants"("id")                     ON DELETE CASCADE,
  "ingest_device_id"    uuid         REFERENCES "collection_ingest_devices"("id")            ON DELETE SET NULL,
  "channel"             text         NOT NULL
    CONSTRAINT "collection_raw_messages_channel_check" CHECK ("channel" IN ('ios_notification', 'ios_sms', 'android_notification', 'android_sms', 'manual_paste', 'statement')),
  "source_app"          text,
  "sender"              text
    CONSTRAINT "collection_raw_messages_sender_check" CHECK (char_length("sender") <= 64),
  "sender_kind"         text         NOT NULL
    CONSTRAINT "collection_raw_messages_sender_kind_check" CHECK ("sender_kind" IN ('alphanumeric', 'numeric', 'app')),
  "client_fingerprint"  text
    CONSTRAINT "collection_raw_messages_client_fingerprint_check" CHECK ("client_fingerprint" ~ '^[A-Za-z0-9_-]{16,64}$'),
  "body_sha256"         text         NOT NULL
    CONSTRAINT "collection_raw_messages_body_sha256_check" CHECK ("body_sha256" ~ '^[0-9a-f]{64}$'),
  "title_enc"           text,
  "body_enc"            text,
  "parse_status"        text         NOT NULL
    CONSTRAINT "collection_raw_messages_parse_status_check" CHECK ("parse_status" IN ('parsed', 'fallback', 'unknown_format', 'not_credit', 'otp', 'too_old', 'duplicate')),
  "template_id"         text,
  "received_at"         timestamptz  NOT NULL,
  "created_at"          timestamptz  NOT NULL DEFAULT now(),
  "expires_at"          timestamptz  NOT NULL,
  "shared_at"           timestamptz,
  "shared_by_user_id"   uuid         REFERENCES "users"("id")                                ON DELETE SET NULL,
  -- An OTP body is never stored (03 §E.4).
  CONSTRAINT "collection_raw_messages_otp_no_body_chk" CHECK (
    "parse_status" <> 'otp' OR ("title_enc" IS NULL AND "body_enc" IS NULL)
  )
);
--> statement-breakpoint
-- Device re-post dedupe. Spec 07 inserts with
-- ON CONFLICT ("tenant_id", "ingest_device_id", "client_fingerprint") WHERE "client_fingerprint" IS NOT NULL.
CREATE UNIQUE INDEX IF NOT EXISTS "collection_raw_messages_device_fp_uq"
  ON "collection_raw_messages" ("tenant_id", "ingest_device_id", "client_fingerprint")
  WHERE "client_fingerprint" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_raw_messages_expires_idx"
  ON "collection_raw_messages" ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_raw_messages_tenant_status_idx"
  ON "collection_raw_messages" ("tenant_id", "parse_status", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collection_credits" (
  "id"                       uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"                uuid           NOT NULL REFERENCES "tenants"("id")                   ON DELETE CASCADE,
  "branch_id"                uuid           REFERENCES "branches"("id")                           ON DELETE RESTRICT,
  "collection_account_id"    uuid           REFERENCES "collection_accounts"("id")                ON DELETE RESTRICT,
  "ingest_device_id"         uuid           REFERENCES "collection_ingest_devices"("id")          ON DELETE SET NULL,
  "raw_message_id"           uuid           REFERENCES "collection_raw_messages"("id")            ON DELETE SET NULL,
  "direction"                text           NOT NULL
    CONSTRAINT "collection_credits_direction_check" CHECK ("direction" IN ('credit', 'debit', 'cash_in')),
  "channels"                 text[]         NOT NULL
    CONSTRAINT "collection_credits_channels_check" CHECK (
      cardinality("channels") >= 1
      AND "channels" <@ ARRAY['ios_notification', 'ios_sms', 'android_notification', 'android_sms', 'manual_paste', 'statement']::text[]
    ),
  "template_id"              text           NOT NULL,
  "amount"                   numeric(14,2)  NOT NULL
    CONSTRAINT "collection_credits_amount_check" CHECK ("amount" > 0),
  "payer_phone_last4"        text
    CONSTRAINT "collection_credits_payer_phone_last4_check" CHECK ("payer_phone_last4" ~ '^[0-9]{4}$'),
  "payer_phone_hmac"         text,
  "payer_name_masked"        text,
  "payer_name"               text,
  "balance_after"            numeric(14,2),
  "operator_reference"       text,
  "receiving_hint"           text,
  "sender"                   text
    CONSTRAINT "collection_credits_sender_check" CHECK (char_length("sender") <= 64),
  "sender_kind"              text           NOT NULL
    CONSTRAINT "collection_credits_sender_kind_check" CHECK ("sender_kind" IN ('alphanumeric', 'numeric', 'app')),
  "occurred_at"              timestamptz    NOT NULL,
  "device_received_at"       timestamptz    NOT NULL,
  "state"                    text           NOT NULL
    CONSTRAINT "collection_credits_state_check" CHECK ("state" IN ('unmatched', 'held', 'matched', 'ignored', 'info')),
  "hold_reason"              text
    CONSTRAINT "collection_credits_hold_reason_check" CHECK ("hold_reason" IN ('ambiguous', 'untrusted_source', 'balance_mismatch', 'no_balance_baseline', 'above_review_limit', 'no_account', 'unverified_format', 'manual_source', 'suspicious_link', 'too_old', 'amount_mismatch', 'auto_confirm_off', 'matches_rejected', 'test')),
  "suggested_collection_id"  uuid           REFERENCES "collections"("id")                        ON DELETE SET NULL,
  "matched_collection_id"    uuid           REFERENCES "collections"("id")                        ON DELETE SET NULL,
  "ignored_reason"           text
    CONSTRAINT "collection_credits_ignored_reason_check" CHECK ("ignored_reason" IN ('personal', 'not_a_sale', 'duplicate', 'other')),
  "decided_by_user_id"       uuid           REFERENCES "users"("id")                              ON DELETE SET NULL,
  "decided_at"               timestamptz,
  "dedupe_key"               text           NOT NULL,
  "seen_count"               integer        NOT NULL DEFAULT 1
    CONSTRAINT "collection_credits_seen_count_check" CHECK ("seen_count" >= 1),
  "is_test"                  boolean        NOT NULL DEFAULT false,
  "created_at"               timestamptz    NOT NULL DEFAULT now(),
  "updated_at"               timestamptz    NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collection_credits_dedupe_uq"
  ON "collection_credits" ("tenant_id", "dedupe_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collection_credits_matched_uq"
  ON "collection_credits" ("matched_collection_id")
  WHERE "matched_collection_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_credits_tenant_state_idx"
  ON "collection_credits" ("tenant_id", "state", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_credits_match_idx"
  ON "collection_credits" ("tenant_id", "collection_account_id", "amount", "occurred_at");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collections_matched_credit_id_fkey') THEN
    ALTER TABLE "collections"
      ADD CONSTRAINT "collections_matched_credit_id_fkey"
      FOREIGN KEY ("matched_credit_id") REFERENCES "collection_credits"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collection_events_actor_device_id_fkey') THEN
    ALTER TABLE "collection_events"
      ADD CONSTRAINT "collection_events_actor_device_id_fkey"
      FOREIGN KEY ("actor_device_id") REFERENCES "collection_ingest_devices"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collection_events_credit_id_fkey') THEN
    ALTER TABLE "collection_events"
      ADD CONSTRAINT "collection_events_credit_id_fkey"
      FOREIGN KEY ("credit_id") REFERENCES "collection_credits"("id") ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "collection_raw_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "collection_raw_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "collection_raw_messages_tenant_isolation" ON "collection_raw_messages";
--> statement-breakpoint
CREATE POLICY "collection_raw_messages_tenant_isolation" ON "collection_raw_messages"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "collection_credits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "collection_credits" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "collection_credits_tenant_isolation" ON "collection_credits";
--> statement-breakpoint
CREATE POLICY "collection_credits_tenant_isolation" ON "collection_credits"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
