-- WhatsApp Cloud API (Meta's official Business Cloud API) credentials.
-- Sits alongside the existing Green API columns so each branch can choose
-- the provider it wants without losing the other's configuration. When
-- both providers are configured, the application prefers the Cloud API
-- (the official channel) and falls back to Green API.
--
-- Per-branch (multi-store): each shop has its own phone-number ID and
-- system-user token, since Meta issues credentials at the phone-number
-- level. Token is encrypted at rest via lib/crypto.

ALTER TABLE "shop_settings"
  ADD COLUMN "whatsapp_cloud_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Phone Number ID from the Meta WhatsApp Business platform (NOT the phone
-- number itself). Looks like a 15-17 digit numeric string.
ALTER TABLE "shop_settings"
  ADD COLUMN "whatsapp_cloud_phone_id" text;
--> statement-breakpoint

-- Permanent system-user access token. Encrypted at rest. Same scheme as
-- green_api_token (lib/crypto encryptSecret/decryptSecret).
ALTER TABLE "shop_settings"
  ADD COLUMN "whatsapp_cloud_token" text;
--> statement-breakpoint

-- Optional WhatsApp Business Account (WABA) ID — useful for diagnostics
-- and for listing templates from the same account. Not required to send.
ALTER TABLE "shop_settings"
  ADD COLUMN "whatsapp_cloud_business_id" text;
