# WhatsApp Cloud API — Developer Onboarding

This guide gets you from "no Meta App" to "tenant clicks Connect WhatsApp and the OAuth flow succeeds in local dev". The production checklist sits at the bottom.

## 1. Create the Meta App

1. Open https://developers.facebook.com/apps and click **Create App**.
2. App type: **Business**. Use-case: pick **Other** so the wizard lets you add products manually.
3. Once the app exists, go to **App settings → Basic** and copy the **App ID** and **App secret**. These become `META_APP_ID` and `META_APP_SECRET`.
4. Add the **WhatsApp** product to the app (left sidebar → Add product → WhatsApp → Set up). This is what surfaces the API Setup and Configuration screens used below.

## 2. Configure Facebook Login for Business

Embedded Signup is a thin wrapper around Facebook Login for Business with a pre-baked configuration.

1. Add the **Facebook Login for Business** product to the app.
2. Open the product's **Configurations** tab and create a new configuration:
   - **Login type**: Business login
   - **Asset type**: WhatsApp Business Account
   - **Permissions**: tick all three —
     - `whatsapp_business_management`
     - `whatsapp_business_messaging`
     - `business_management`
   - Save and copy the **Configuration ID** — this is `META_CONFIG_ID`.
3. In **Settings → Basic** scroll to **Valid OAuth Redirect URIs** and add the callback URL you'll use. For local dev with ngrok this looks like:
   ```
   https://<random>.ngrok-free.app/api/whatsapp/oauth/callback
   ```
   Exact match — protocol, host, path, no trailing slash. `META_OAUTH_REDIRECT_URL` must be the same string.

## 3. Required scopes

App Review approval is needed before the OAuth flow works for users who are *not* admins of your Meta App. Submit the same three scopes:

- `whatsapp_business_management` — read/write WABA + subscribed apps
- `whatsapp_business_messaging` — send messages
- `business_management` — read business + verification status

During Review you'll need a screen recording walking through:
1. Tenant clicking "Connect WhatsApp" in our settings page.
2. The Embedded Signup popup.
3. Successful connection + a test message landing.

Until approved, only Meta App admins/developers/testers (set in **App roles**) can complete the flow; everyone else gets `(#200) Permissions error`.

## 4. Local dev — ngrok / cloudflared

Meta requires HTTPS for OAuth callbacks and webhooks. Local Next dev (`http://localhost:3000`) won't fly. Pick one:

**ngrok** (one-off, no account needed for short sessions):
```bash
ngrok http 3000
```
Copy the `https://<random>.ngrok-free.app` URL.

**cloudflared** (persistent named tunnel, free tier OK):
```bash
cloudflared tunnel --url http://localhost:3000
```

Either way, plug the public URL into:
- Meta App → **Valid OAuth Redirect URIs**: `https://<host>/api/whatsapp/oauth/callback`
- `.env`: `META_OAUTH_REDIRECT_URL=https://<host>/api/whatsapp/oauth/callback`
- *(Phase 2)* Meta App → WhatsApp → Configuration → **Webhook URL**: `https://<host>/api/whatsapp/webhook`

When the ngrok URL rotates (every restart on the free tier), update both Meta and `.env`. Use a paid static subdomain or cloudflared if this annoys you.

## 5. Environment variables

Add these to `.env` (see `.env.example` for the full block):

| Var | Required | What it is |
|---|---|---|
| `META_APP_ID` | yes | App ID from developers.facebook.com → Settings → Basic |
| `META_APP_SECRET` | yes | App secret (treat like a database password) |
| `META_CONFIG_ID` | yes | Facebook Login for Business Configuration ID (step 2) |
| `META_OAUTH_REDIRECT_URL` | yes | Full HTTPS callback URL — must match what's whitelisted in the Meta App |
| `META_GRAPH_VERSION` | no | Defaults to `v21.0`. Bump deliberately when Meta deprecates |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Phase 2 | Shared secret for the webhook challenge. Generate with `openssl rand -hex 32` |
| `NEXT_PUBLIC_META_APP_ID` | optional | Reserved for the JS-SDK popup variant; safe to leave blank for now |
| `AUTH_SECRET` | yes (existing) | Reused for HMAC-signing OAuth state. Already required at app boot |
| `SECRET_KEY` | yes (existing) | AES-256-GCM key for encrypting stored tokens at rest |

## 5b. Webhook URL registration (Phase 2)

Once `WHATSAPP_WEBHOOK_VERIFY_TOKEN` is set in `.env`:

1. Meta App → WhatsApp → Configuration → **Webhook**
2. Click **Edit** and enter:
   - **Callback URL**: `https://<your-host>/api/whatsapp/webhook`
   - **Verify token**: same string as `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
3. Click **Verify and save**. Meta will GET your callback URL with `hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`; our handler responds 200 with the challenge echoed back when the token matches.
4. Subscribe to the **messages** field. Optional but useful: **message_template_status_update** (Phase 4).
5. Per-WABA subscription happens automatically inside the OAuth callback (`subscribeAppToWaba`). For WABAs connected before this Phase shipped, click **Reconnect** in the settings UI — the OAuth flow re-runs the subscribe call.

Confirm by sending a message **to** the connected WhatsApp number from a personal phone — within a few seconds you should see:
- A new row in `wa_webhook_events` with `processing_status='processed'`, `event_type='message.received'`.
- A new row in `wa_messages` with `direction='inbound'`, the text body, and the sender's phone.

If you instead see `processing_status='quarantined'` with `tenant_id=NULL`, the receiving `phone_number_id` doesn't match any connection — usually means you sent to a different test number than the one OAuth bound.

## 6. Verify the wiring

1. Open `/settings` while logged in as an owner.
2. Click **Connect WhatsApp** in the "WhatsApp Cloud API — القناة الرسمية من Meta" card.
3. You should land on Meta's OAuth dialog. Approve.
4. After redirect, the card flips to the active-connection panel with:
   - Verified business name
   - Display phone number
   - WABA ID + Phone Number ID (monospaced)
   - `sandbox` or `live` badge
   - `webhook معلّق` badge if subscription failed (Phase 2 fixes this)
5. Click **فحص الاتصال** (health check) — should return "Connection is healthy."

## 7. Common OAuth failure modes

| Symptom on `/settings?wa=error&wa_detail=…` | Cause | Fix |
|---|---|---|
| `Invalid state` | Browser dropped the state cookie, or you reopened the callback URL after the cookie expired (15min). | Click Connect again to mint a fresh state. |
| `Expired or invalid state` | Same as above, but the state itself is past TTL. | Reconnect. |
| `Missing code or state` | User landed on `/api/whatsapp/oauth/callback` without going through `/start` (e.g. bookmark). | Don't bookmark the callback URL. |
| `(#200) Permissions error` | App not approved for the requested scopes for this user. | Add the user as App role tester/developer during dev, or finish App Review. |
| `Invalid redirect URI` (on Meta's dialog itself) | `META_OAUTH_REDIRECT_URL` doesn't byte-match the whitelist. | Compare carefully — protocol, host, path. No `?`/`#`. |
| `No WhatsApp Business Account was granted` | User cancelled WABA selection in the Embedded Signup popup. | Reconnect and pick a WABA. |
| `WABA has no phone number yet` | The chosen WABA has no phone configured. | Add+verify a number in Meta Business Manager, then reconnect. |
| `Token exchange failed (code 100)` | `META_APP_SECRET` is wrong or the code was already redeemed. | Double-check secret; redeem each code exactly once. |
| `extendToken failed, keeping short-lived` (log line) | App lacks the right BSP integration to extend to a 60-day token. | OK for sandbox, but the connection will need reconnect within ~1 hour. Verify Login for Business config. |

## 8. Logs to watch

The structured logger emits one JSON line per event when `LOG_FORMAT=json` (auto-enabled in production). Useful filters:

- `event:"wa.oauth.start"` — every Connect click
- `event:"wa.oauth.connected"` — successful onboarding (includes `mode`, `tokenType`, `scopesGranted`)
- `event:"wa.oauth.csrf_mismatch"` — possible CSRF or browser cookie loss
- `event:"wa.oauth.code_exchange_failed"` / `wa.oauth.discovery_failed` / `wa.oauth.persist_failed` — flow failures
- `event:"wa.graph.error"` — every Graph 4xx/5xx (includes `metaCode`, `metaSubcode`, `status`, `durationMs`)
- `event:"wa.healthcheck.completed"` — manual or scheduled health check outcome
- `event:"webhook.verify.*"` — subscription handshake outcomes (GET)
- `event:"webhook.signature.invalid"` — rejected webhooks (with discriminated `reason`)
- `event:"webhook.receive.ok"` — accepted webhook batch (with `eventCount`, `durationMs`)
- `event:"wa.webhook.routed"` / `wa.webhook.quarantined"` / `"wa.webhook.dedup"` — per-event routing outcomes
- `event:"wa.webhook.process.ok"` / `"wa.webhook.retry_scheduled"` / `"wa.webhook.deadletter"` — processor state transitions

Tokens, secrets, and the encrypted blob are never emitted. The logger redacts a fixed set of field names; if you add a new sensitive field, list it in `SENSITIVE_KEYS` in `lib/logger.ts`.

## 9. Production checklist

- [ ] App switched to Live mode in Meta dashboard
- [ ] App Review approved for all three scopes
- [ ] Business verification completed for the Meta App's Business
- [ ] Production callback URL whitelisted (matches `META_OAUTH_REDIRECT_URL`)
- [ ] *(Phase 2)* Production webhook URL whitelisted + `WHATSAPP_WEBHOOK_VERIFY_TOKEN` matches
- [ ] `LOG_LEVEL=info` and `LOG_FORMAT=json` in the prod env
- [ ] `SECRET_KEY` and `AUTH_SECRET` are unique per environment (don't reuse dev values)
- [ ] Token rotation plan: long-lived tokens are 60 days. Schedule a `runHealthCheck` cron for each active connection daily; the UI will prompt reconnect when `connection_error_state` flips to `token_expired`

## 10. Where the code lives

```
lib/whatsapp/meta-graph.ts          Graph client (typed)
lib/whatsapp/connections.ts         Repo + tenant routing
lib/whatsapp/resolve-credentials.ts Send-route credential picker
lib/whatsapp/oauth-state.ts         HMAC-signed state + cookie binding
lib/whatsapp/health.ts              Health-check service
lib/whatsapp/webhook-signature.ts   X-Hub-Signature-256 verification
lib/whatsapp/webhook-types.ts       Typed Meta webhook payloads
lib/whatsapp/webhook-events.ts      Event repo + idempotent extract
lib/whatsapp/webhook-processor.ts   Tenant routing + processing state machine
lib/whatsapp/messages.ts            Inbound/outbound message repo
lib/logger.ts                       Structured logger

app/api/whatsapp/oauth/start/       OAuth entry
app/api/whatsapp/oauth/callback/    OAuth exchange + persist
app/api/whatsapp/oauth/disconnect/  Logical disconnect
app/api/whatsapp/connection/        Status read
app/api/whatsapp/connection/healthcheck/  Manual health probe
app/api/whatsapp/cloud/send/        Text send (OAuth or manual creds)
app/api/whatsapp/cloud/send-pdf/    Document send
app/api/whatsapp/webhook/           GET challenge + POST event receiver
app/api/whatsapp/webhook/events/    Admin inspection (quarantine, dead-letter)

lib/db/migrations/0019_wa_connections.sql                 Connection table + RLS
lib/db/migrations/0020_wa_connections_health.sql          Health metadata columns
lib/db/migrations/0021_wa_webhook_events_and_messages.sql Webhook + messages tables
```
