-- Digital collections, milestone M1 (mobile-dev-docs/15-digital-collections, spec 04;
-- every name comes from 03-architecture.md §B.2 — change it there first).
--
-- Egyptian customers pay shops by InstaPay and by mobile wallet. There is no API
-- into the owner's own bank or wallet, and the counter fraud is the edited
-- screenshot, so a digital sale is recorded as "paid — awaiting confirmation"
-- and the owner confirms or rejects it against the receiving side.
--
--   collection_accounts  the owner's receiving accounts (InstaPay IPA / bank
--                        suffix / IBAN, wallet numbers), optionally per branch
--   collections          one row per expected transfer ("part", 1..4 per sale)
--   collection_events    append-only audit trail per collection
--   sales.collection_status        the verification axis, orthogonal to is_paid
--   sale_payments.collection_id / voided_at, and 'wallet' in the method CHECK
--   shop_settings.collections_*    five per-branch switches
--
-- Additive only: three new tables, nullable columns, NOT NULL columns with
-- constant defaults (no table rewrite on PG 16), partial indexes. No existing
-- row changes value. The sale_payments CHECK is replaced by a superset, so every
-- existing row still passes. Indexes are built inside the migrator's single
-- transaction (no concurrent build is possible there).
--
-- RLS: ENABLE + FORCE + "<table>_tenant_isolation" on all three new tables
-- (pattern 0038_sale_payments.sql). DROP POLICY IF EXISTS first so a re-run on a
-- hand-patched dev DB does not fail.
--
-- The FK on collections.matched_credit_id and the two on collection_events
-- (actor_device_id, credit_id) point at 0056 tables; 0056 adds them.

CREATE TABLE IF NOT EXISTS "collection_accounts" (
  "id"                      uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"               uuid           NOT NULL REFERENCES "tenants"("id")  ON DELETE CASCADE,
  "branch_id"               uuid           REFERENCES "branches"("id")          ON DELETE RESTRICT,
  "rail"                    text           NOT NULL
    CONSTRAINT "collection_accounts_rail_check" CHECK ("rail" IN ('instapay', 'wallet')),
  "provider"                text           NOT NULL,
  "label"                   text           NOT NULL
    CONSTRAINT "collection_accounts_label_check" CHECK (char_length("label") BETWEEN 1 AND 60),
  "holder_name"             text
    CONSTRAINT "collection_accounts_holder_name_check" CHECK (char_length("holder_name") <= 80),
  "ipa_handle"              text
    CONSTRAINT "collection_accounts_ipa_handle_check" CHECK ("ipa_handle" ~ '^[a-z0-9._-]{3,60}@instapay$'),
  "ipa_link"                text,
  "account_last4"           text
    CONSTRAINT "collection_accounts_account_last4_check" CHECK ("account_last4" ~ '^[0-9]{4}$'),
  "is_prepaid_card"         boolean        NOT NULL DEFAULT false,
  "iban"                    text
    CONSTRAINT "collection_accounts_iban_check" CHECK ("iban" ~ '^EG[0-9]{27}$'),
  "wallet_msisdn"           text
    CONSTRAINT "collection_accounts_wallet_msisdn_check" CHECK ("wallet_msisdn" ~ '^\+201[0125][0-9]{8}$'),
  "wallet_opened_on"        date,
  "is_default_for_mobile"   boolean        NOT NULL DEFAULT false,
  "is_pos_default"          boolean        NOT NULL DEFAULT false,
  "auto_confirm_enabled"    boolean        NOT NULL DEFAULT false,
  "review_threshold"        numeric(14,2)  NOT NULL DEFAULT 5000.00
    CONSTRAINT "collection_accounts_review_threshold_check" CHECK ("review_threshold" >= 0),
  "balance_check_enabled"   boolean        NOT NULL DEFAULT true,
  "balance_baseline"        numeric(14,2),
  "balance_baseline_at"     timestamptz,
  "balance_chain_broken_at" timestamptz,
  "sort_order"              integer        NOT NULL DEFAULT 0,
  "created_by_user_id"      uuid           REFERENCES "users"("id")             ON DELETE SET NULL,
  "created_at"              timestamptz    NOT NULL DEFAULT now(),
  "updated_at"              timestamptz    NOT NULL DEFAULT now(),
  "archived_at"             timestamptz,
  -- An account must be identifiable by at least one routing key (03 §B.2.1).
  CONSTRAINT "collection_accounts_identity_chk" CHECK (
    "wallet_msisdn" IS NOT NULL OR "ipa_handle" IS NOT NULL OR "ipa_link" IS NOT NULL
    OR "account_last4" IS NOT NULL OR "iban" IS NOT NULL OR "is_prepaid_card"
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_accounts_tenant_branch_idx"
  ON "collection_accounts" ("tenant_id", "branch_id")
  WHERE "archived_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collection_accounts_tenant_msisdn_uq"
  ON "collection_accounts" ("tenant_id", "wallet_msisdn")
  WHERE "wallet_msisdn" IS NOT NULL AND "archived_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collection_accounts_tenant_provider_last4_uq"
  ON "collection_accounts" ("tenant_id", "provider", "account_last4")
  WHERE "account_last4" IS NOT NULL AND "archived_at" IS NULL;
--> statement-breakpoint
-- One POS default per rail per branch; a tenant-wide account (branch_id NULL)
-- counts as its own "branch" through the zero uuid.
CREATE UNIQUE INDEX IF NOT EXISTS "collection_accounts_pos_default_uq"
  ON "collection_accounts" ("tenant_id", COALESCE("branch_id", '00000000-0000-0000-0000-000000000000'::uuid), "rail")
  WHERE "is_pos_default" AND "archived_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collections" (
  "id"                     uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"              uuid           NOT NULL REFERENCES "tenants"("id")              ON DELETE CASCADE,
  "branch_id"              uuid           NOT NULL REFERENCES "branches"("id")             ON DELETE RESTRICT,
  "source_type"            text           NOT NULL
    CONSTRAINT "collections_source_type_check" CHECK ("source_type" IN ('sale', 'settlement')),
  "invoice_id"             text,
  "anchor_sale_id"         uuid           REFERENCES "sales"("id")                         ON DELETE SET NULL,
  "customer_phone"         text,
  "method"                 text           NOT NULL
    CONSTRAINT "collections_method_check" CHECK ("method" IN ('instapay', 'wallet')),
  "collection_account_id"  uuid           REFERENCES "collection_accounts"("id")           ON DELETE RESTRICT,
  "amount"                 numeric(14,2)  NOT NULL
    CONSTRAINT "collections_amount_check" CHECK ("amount" > 0),
  "part_no"                smallint       NOT NULL DEFAULT 1
    CONSTRAINT "collections_part_no_check" CHECK ("part_no" BETWEEN 1 AND 4),
  "status"                 text           NOT NULL DEFAULT 'pending'
    CONSTRAINT "collections_status_check" CHECK ("status" IN ('pending', 'confirmed', 'auto_confirmed', 'rejected', 'void')),
  "payer_phone_last4"      text
    CONSTRAINT "collections_payer_phone_last4_check" CHECK ("payer_phone_last4" ~ '^[0-9]{4}$'),
  "payer_reference"        text
    CONSTRAINT "collections_payer_reference_check" CHECK ("payer_reference" ~ '^[0-9a-z]{4,16}$'),
  "rung_at"                timestamptz    NOT NULL,
  "recorded_by_user_id"    uuid           REFERENCES "users"("id")                         ON DELETE SET NULL,
  "matched_credit_id"      uuid,
  "decided_by_user_id"     uuid           REFERENCES "users"("id")                         ON DELETE SET NULL,
  "decided_at"             timestamptz,
  "reject_reason"          text
    CONSTRAINT "collections_reject_reason_check" CHECK ("reject_reason" IN ('not_received', 'wrong_amount', 'wrong_account', 'duplicate', 'other')),
  "reject_outcome"         text
    CONSTRAINT "collections_reject_outcome_check" CHECK ("reject_outcome" IN ('debt', 'loss')),
  "decision_note"          text
    CONSTRAINT "collections_decision_note_check" CHECK (char_length("decision_note") <= 280),
  "stale_notified_at"      timestamptz,
  "flags"                  text[]         NOT NULL DEFAULT '{}'::text[],
  "created_at"             timestamptz    NOT NULL DEFAULT now(),
  "updated_at"             timestamptz    NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collections_tenant_status_rung_idx"
  ON "collections" ("tenant_id", "status", "rung_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collections_match_idx"
  ON "collections" ("tenant_id", "collection_account_id", "amount", "rung_at")
  WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collections_tenant_invoice_idx"
  ON "collections" ("tenant_id", "invoice_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collections_tenant_branch_rung_idx"
  ON "collections" ("tenant_id", "branch_id", "rung_at");
--> statement-breakpoint
-- Idempotent replay: the cart path inserts with
-- ON CONFLICT ("tenant_id", "invoice_id", "part_no") WHERE "source_type" = 'sale' DO NOTHING.
-- The predicate must stay byte-identical to what spec 05 writes.
CREATE UNIQUE INDEX IF NOT EXISTS "collections_sale_part_uq"
  ON "collections" ("tenant_id", "invoice_id", "part_no")
  WHERE "source_type" = 'sale';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collections_matched_credit_uq"
  ON "collections" ("matched_credit_id")
  WHERE "matched_credit_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collection_events" (
  "id"               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"        uuid         NOT NULL REFERENCES "tenants"("id")      ON DELETE CASCADE,
  "collection_id"    uuid         NOT NULL REFERENCES "collections"("id")  ON DELETE CASCADE,
  "kind"             text         NOT NULL
    CONSTRAINT "collection_events_kind_check" CHECK ("kind" IN ('created', 'matched', 'auto_confirmed', 'confirmed', 'rejected', 'reopened', 'voided', 'amount_changed', 'account_changed', 'evidence_attached', 'stale_alerted', 'note')),
  "from_status"      text,
  "to_status"        text,
  "actor_user_id"    uuid         REFERENCES "users"("id")                 ON DELETE SET NULL,
  "actor_device_id"  uuid,
  "credit_id"        uuid,
  "details"          jsonb        NOT NULL DEFAULT '{}'::jsonb,
  "created_at"       timestamptz  NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_events_collection_idx"
  ON "collection_events" ("collection_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_events_tenant_idx"
  ON "collection_events" ("tenant_id", "created_at");
--> statement-breakpoint
ALTER TABLE "sales"
  ADD COLUMN IF NOT EXISTS "collection_status" text
  CONSTRAINT "sales_collection_status_check" CHECK ("collection_status" IN ('pending', 'confirmed', 'rejected'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_tenant_collection_pending_idx"
  ON "sales" ("tenant_id", "sale_date")
  WHERE "collection_status" = 'pending';
--> statement-breakpoint
ALTER TABLE "sale_payments"
  ADD COLUMN IF NOT EXISTS "collection_id" uuid
  CONSTRAINT "sale_payments_collection_id_fkey" REFERENCES "collections"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN IF NOT EXISTS "voided_at" timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sale_payments_collection_idx"
  ON "sale_payments" ("collection_id")
  WHERE "collection_id" IS NOT NULL;
--> statement-breakpoint
-- 0038 created the method CHECK inline, so Postgres named it
-- sale_payments_method_check. Replace it with the superset that adds 'wallet'.
-- Guarded like 0031_user_locale.sql:20 (Postgres has no ADD CONSTRAINT IF NOT
-- EXISTS): drop only a definition that lacks 'wallet', add only when absent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sale_payments_method_check'
      AND conrelid = 'sale_payments'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%''wallet''%'
  ) THEN
    ALTER TABLE "sale_payments" DROP CONSTRAINT "sale_payments_method_check";
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sale_payments_method_check'
      AND conrelid = 'sale_payments'::regclass
  ) THEN
    ALTER TABLE "sale_payments"
      ADD CONSTRAINT "sale_payments_method_check"
      CHECK ("method" IN ('cash', 'instapay', 'wallet', 'card', 'initial'));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "shop_settings" ADD COLUMN IF NOT EXISTS "collections_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "shop_settings" ADD COLUMN IF NOT EXISTS "collections_require_account" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "shop_settings"
  ADD COLUMN IF NOT EXISTS "collections_stale_after_minutes" integer NOT NULL DEFAULT 120
  CONSTRAINT "shop_settings_collections_stale_after_minutes_check"
  CHECK ("collections_stale_after_minutes" BETWEEN 15 AND 1440);
--> statement-breakpoint
ALTER TABLE "shop_settings" ADD COLUMN IF NOT EXISTS "collections_auto_confirm_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "shop_settings" ADD COLUMN IF NOT EXISTS "collections_store_payer_names" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "collection_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "collection_accounts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "collection_accounts_tenant_isolation" ON "collection_accounts";
--> statement-breakpoint
CREATE POLICY "collection_accounts_tenant_isolation" ON "collection_accounts"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "collections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "collections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "collections_tenant_isolation" ON "collections";
--> statement-breakpoint
CREATE POLICY "collections_tenant_isolation" ON "collections"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "collection_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "collection_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "collection_events_tenant_isolation" ON "collection_events";
--> statement-breakpoint
CREATE POLICY "collection_events_tenant_isolation" ON "collection_events"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
