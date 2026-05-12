-- WhatsApp Cloud API connections. Each row binds one (tenant, branch) to a
-- single Meta phone_number_id (and its parent WABA + business). Written by
-- the Embedded Signup OAuth callback; read by send routes, the settings UI,
-- and (Phase 2) the webhook handler when it routes inbound events back to
-- the right tenant by phone_number_id.
--
-- Provider-agnostic shape: `provider` defaults to 'meta_cloud' but reserved
-- for future SMS fallback providers (Twilio, Vonage, etc.) without another
-- schema migration. status / mode are text-enums; the application clamps.

CREATE TABLE IF NOT EXISTS "wa_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "branch_id" uuid NOT NULL REFERENCES "branches"("id") ON DELETE CASCADE,

  "provider" text NOT NULL DEFAULT 'meta_cloud',

  "waba_id" text NOT NULL,
  "phone_number_id" text NOT NULL,
  "business_id" text,
  "display_phone_number" text,
  "verified_name" text,

  -- Encrypted at rest via lib/crypto (encryptSecret). Stored as the
  -- "v1:<iv>:<ct>:<tag>" string format the helper produces.
  "access_token" text NOT NULL,
  "token_type" text NOT NULL DEFAULT 'long_lived',
  "token_expires_at" timestamp with time zone,
  "scopes" text,

  "status" text NOT NULL DEFAULT 'active',
  "mode" text NOT NULL DEFAULT 'sandbox',
  "webhook_subscribed" boolean NOT NULL DEFAULT false,

  "connected_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "connected_at" timestamp with time zone NOT NULL DEFAULT now(),
  "disconnected_at" timestamp with time zone,
  "last_synced_at" timestamp with time zone,
  "last_error" text,
  "raw_metadata" jsonb,

  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- phone_number_id is globally unique on Meta's side and is the primary
-- routing key for incoming webhooks. Enforce that here too.
CREATE UNIQUE INDEX IF NOT EXISTS "wa_connections_phone_number_id_uniq"
  ON "wa_connections" ("phone_number_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_connections_tenant_idx"
  ON "wa_connections" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_connections_branch_idx"
  ON "wa_connections" ("tenant_id", "branch_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_connections_waba_idx"
  ON "wa_connections" ("waba_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_connections_status_idx"
  ON "wa_connections" ("status");
--> statement-breakpoint

-- RLS — same NULLIF guard pattern as shop_settings (migration 0004). The
-- webhook handler runs OUTSIDE this context (it uses the admin db handle to
-- discover the tenant first, then opens withTenant), so the policy is safe.
ALTER TABLE "wa_connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "wa_connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "wa_connections_tenant_isolation" ON "wa_connections"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
