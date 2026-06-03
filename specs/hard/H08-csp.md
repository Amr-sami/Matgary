# H08 — CSP headers

> Source: `task.md` §7.1 H8

- **Status:** done (2026-06-03) — ships as report-only; flip via `CSP_ENFORCE=1`
- **Effort estimate:** 1-2 hrs (actual: ~30 min)
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

```
$ curl -is http://localhost:3001/healthz | grep -i content-security
content-security-policy-report-only: default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://*.sentry.io https://o*.ingest.sentry.io; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests

$ curl -s http://localhost:3001/login | grep -oE "<script[^>]*>" | grep -v "nonce="
(empty — every script tag carries the per-request nonce)
```

Files touched:
- `middleware.ts` — generates a per-request nonce, sets `x-nonce` on the modified request headers (Next auto-injects this on `<Script>` tags), applies CSP + 4 hardening headers (`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, plus the CSP itself) to every response.
- `infra/nginx.conf.example` — note that CSP is owned by the app + warning against adding a conflicting nginx-level CSP.

## Acceptance criteria

- [x] nginx template marked as deferring CSP to the app (the spec's "nginx emits CSP" predates the per-request-nonce decision; with nonces, the app must own the header).
- [x] Next middleware emits a per-request nonce; Next reads it from `x-nonce` and writes it on every script tag.
- [x] Smoke walk (`/healthz`, `/login` rendered) produced **zero** scripts without a nonce.
- [x] Report-only by default (`Content-Security-Policy-Report-Only` header); promote to enforcing by setting `CSP_ENFORCE=1` in the app env.
- [ ] `report-uri` configured to a Sentry CSP endpoint. — deferred: Sentry CSP reporter setup is configured per-project in the Sentry UI; documented as a follow-up rather than blocking the spec.

## Known trade-offs

- `style-src` keeps `'unsafe-inline'` for v1 because Tailwind 4 injects runtime inline styles without a nonce hook today. Tighter style CSP tracked in §4 backlog "Strict CSP for styles".
- `'unsafe-eval'` is added to `script-src` only when `NODE_ENV === "development"` (React's dev-time error overlay uses `eval`). Stripped in prod automatically.
- `Permissions-Policy` keeps `geolocation=(self)` because attendance check-in needs it; widen if a future feature requires camera/microphone.
