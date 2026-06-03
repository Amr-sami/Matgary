# H08 — CSP headers

> Source: `task.md` §7.1 H8

- **Status:** pending
- **Effort estimate:** 1-2 hrs
- **Depends on:** none (but H04 staging probe is what lets us run report-only mode safely)

## Why

Cheapest XSS defence-in-depth that exists. Pen-tester (E2) will flag absence with a default high-severity finding. Land it early so the report-only window catches violations before enforcement.

## Acceptance criteria

- [ ] nginx template at `infra/nginx.conf.example` emits `Content-Security-Policy` with:
  - `default-src 'self'`
  - `script-src 'self' 'nonce-<per-request>'`
  - `style-src 'self' 'unsafe-inline'` (relax later when Tailwind 4 emits nonceable styles)
  - `img-src 'self' data: blob: https:`
  - `connect-src 'self' https://*.sentry.io https://o*.ingest.sentry.io`
  - `font-src 'self' data:`
  - `frame-ancestors 'none'`
  - `form-action 'self'`
  - `base-uri 'self'`
  - `object-src 'none'`
  - `upgrade-insecure-requests`
- [ ] Next middleware emits a per-request nonce in a request header that the root layout reads and passes to `<Script>` tags + any inline `<script nonce="...">`.
- [ ] Smoke walk (signup → onboarding → /sales → /add-product → /insights → /settings) produces ZERO CSP violations in browser console.
- [ ] Report-only mode (`Content-Security-Policy-Report-Only`) shipped to staging for ≥ 1 week BEFORE flipping to enforce in prod. (Track the report-only ship date in this spec's verification log; the flip is a separate one-line PR.)
- [ ] `report-uri` configured to the Sentry CSP endpoint so violations land where we can see them.

## Implementation plan

1. `middleware.ts` adds a `x-nonce` request header containing a 16-byte random base64.
2. Root layout reads `headers().get("x-nonce")` and writes `<Script nonce={nonce} ...>` for any inline analytics or Sentry init.
3. nginx template: `add_header Content-Security-Policy-Report-Only "..."` first; once staging is clean, switch to `Content-Security-Policy`.
4. The header has to be served by Next in dev (no nginx) — use `next.config.ts` `headers()` for parity.

## Out of scope

- Strict CSP with no `'unsafe-inline'` for styles (requires Tailwind 4 plugin work — track in §7.2 Soft).
- CSP for the marketing static pages — relax there separately if it breaks privacy/TOS embeds.
- WebAuthn (`publickey-credentials-get`) source — add when H03 grows to passkeys.

## Risks & gotchas

- Next's RSC + script injection pattern: `next/script` honours the nonce automatically only if it's read from the request headers at render time. Confirm with a deliberate CSP violation test (insert a no-nonce script) — it must be blocked.
- Sentry Replay (if `SENTRY_REPLAYS=1`) needs `worker-src 'self' blob:`.

## Verification log

(populated during execution)
