-- Token + connection health metadata. Phase 1 was deliberately thin on
-- runtime diagnostics (just last_error + last_synced_at). This adds the
-- columns the health-check service writes to, and the UI reads to decide
-- whether to nudge the operator to reconnect.

ALTER TABLE "wa_connections"
  -- Last time we proved the access_token is still valid by calling
  -- /debug_token. Distinct from `last_synced_at` which is bumped on every
  -- field write — this one only moves on a successful Graph validation.
  ADD COLUMN "token_last_validated_at" timestamp with time zone;
--> statement-breakpoint

-- Last time the full health-check ran (token + WABA + phone number).
-- Used to throttle the UI's "Run check" button to once a minute.
ALTER TABLE "wa_connections"
  ADD COLUMN "last_graph_healthcheck_at" timestamp with time zone;
--> statement-breakpoint

-- Machine-readable connection state code so the UI can render an
-- actionable banner without parsing free-form error strings. Values used
-- today (extensible; treat unknown values as 'unknown' in code):
--   null            healthy / never checked
--   'ok'            last check passed
--   'token_expired' /debug_token reports is_valid=false or expired
--   'token_revoked' Meta returned OAuthException code 190 / subcode 458
--   'scope_missing' granted scopes are missing one of the BSP scopes
--   'waba_inaccessible' WABA returned 401/403/404
--   'phone_unverified'  phone number lacks verified_name or
--                       code_verification_status != 'VERIFIED'
--   'network'       transient network/Graph 5xx — UI shows "retry"
ALTER TABLE "wa_connections"
  ADD COLUMN "connection_error_state" text;
