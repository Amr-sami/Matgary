# Heavy E2E Test Plan — Today's Surface

Owner: Amr · Reviewer: me, drafted 2026-06-07

Companion spec for the Playwright suite that proves every piece of
today's work — i18n, auth-hardening, onboarding rework, password reset
locale-awareness, security fixes (F-01..F-04) — works end-to-end with
no regressions. "Heavy" = comprehensive, multi-flow, deep happy and
unhappy paths, multi-tenant, with rate-limit and JWT-race coverage.

This is the **spec** — implementation comes after review.

---

## 1. Goal

Catch any regression introduced by the last 7 sessions of work,
end-to-end, in a real browser against a real Postgres + Redis. The
suite should:

- Exercise every observable behaviour of every shipped feature.
- Drive both happy and failure paths.
- Hit the rate-limit walls (F-03 + F-04 + email-check) and verify
  responses.
- Validate JWT refresh races (onboarding completion).
- Validate locale-aware mail by intercepting outbound mail rather
  than reading inboxes.
- Confirm middleware redirects (locale prefix, onboarding gate,
  query preservation).
- Run in under ~3 minutes against a warm dev server. Acceptable up
  to 5 minutes for a CI cold-cache run.

**Out of scope for this run**: Phase-2 logged-in-app translation,
non-pre-login surfaces, billing flows, the WhatsApp send paths (those
have their own coverage), file uploads.

---

## 2. Test environment

Required services running, healthy:

| Service | Why | Verify |
| --- | --- | --- |
| Postgres (matgary-postgres) | tenants, users, sessions | `docker exec ... pg_isready` |
| Redis (matgary-redis) | rate-limit buckets, password-reset tokens | `docker exec ... redis-cli PING` |
| Next.js dev server (`npm run dev` on :3000) | the app | `curl -sf /healthz` |
| **NEW**: a mail sink — either MailHog on :8025 OR a stub mailer | locale-email assertions | `curl -sf http://localhost:8025/api/v2/messages` |

**Pre-run setup** (in a `globalSetup` script):

```ts
// tests/e2e/global-setup.ts
1. Flush Redis (rate-limit buckets, reset-token store)
   docker exec matgary-redis redis-cli FLUSHDB
2. Confirm DB migrations are applied (run `npm run db:migrate` — should
   say "Migrations complete." idempotently after F-01).
3. Confirm dev server responds to /healthz.
4. Create one persistent test-owner account (owner of "perma" tenant)
   for cross-tenant + 2FA tests. Lookup-or-create idempotent.
```

**Pre-run env overrides** (in `.env.test.local`, not committed):

```
SMTP_HOST=localhost
SMTP_PORT=1025          # MailHog SMTP
SMTP_FROM=test@matgary.test
NEXT_PUBLIC_TEST_MODE=1 # exposes /api/__test/* helpers (see §6)
```

If MailHog isn't available, the suite falls back to a **server-side
mailer stub**: a tiny module that, when `NEXT_PUBLIC_TEST_MODE=1`,
diverts `sendMail()` to an in-memory list exposed at
`/api/__test/mail-outbox`. The endpoint is `PUBLIC_PATHS`-gated by
`NEXT_PUBLIC_TEST_MODE` so it never reaches production.

---

## 3. Test groups & scenarios

Grouped by independence. Each group is `test.describe.configure({mode:
"serial"})`; groups themselves can run in any order.

### Group A — Public surface (no session needed)

**A1. Open-redirect closure (F-01 from auth-hardening)**
- Visit `/ar/login?next=https://example.com/danger`.
- Fill credentials of a known good account, submit.
- **Assert**: `window.location.href` after submit is `/` (or
  `/dashboard`), never `example.com`.
- Variants: `?next=//example.com`, `?next=/\\evil`, `?next=javascript:alert(1)`.

**A2. Locale switcher hard navigation**
- Open `/ar/welcome`. Assert `<html lang="ar" dir="rtl">`.
- Click globe → English.
- Assert URL → `/en/welcome`, `<html lang="en" dir="ltr">`.
- Assert `NEXT_LOCALE=en` cookie set.
- Switch back to ع. Same assertions in reverse.

**A3. Bare-slug locale redirect**
- GET `/welcome` (no cookie) → 307 → `/ar/welcome`.
- GET `/welcome` with `Accept-Language: en-US,en;q=0.9` → 307 →
  `/en/welcome`.
- GET `/welcome` with `Cookie: NEXT_LOCALE=en` → 307 → `/en/welcome`
  (cookie beats Accept-Language).

**A4. Anonymous app-route gate**
- GET `/dashboard` (no session) → 307 → `/ar/login?next=%2Fdashboard`.
- GET `/dashboard?from=yesterday` (no session) → 307 →
  `/ar/login?next=%2Fdashboard%3Ffrom%3Dyesterday` (F-26 query preserved).

**A5. Email-check endpoint shape**
- Fresh address → `{available:true}`.
- Known-taken (the persistent test-owner email) → `{available:false}`.
- Malformed → `{available:false, reason:"invalid"}`.

**A6. Email-check rate limit (F-08, retained from validation)**
- 60 calls from the same IP within a minute → all 200.
- 61st call → still 200 but `{available:false, reason:"invalid"}` —
  shape-indistinguishable from malformed input.
- Wait 60s OR flush Redis → next call returns the real availability.

**A7. 2fa-needed endpoint**
- POST `{email:<known-non-2fa user>}` → `{needsTotp:false}`.
- POST `{email:<known-2fa-enabled user>}` → `{needsTotp:true}`.
- POST 31 times from one IP → all subsequent return `{needsTotp:false}`
  (rate-limit deception).

**A8. Reset-validate endpoint**
- GET `?token=` (empty) → `{valid:false}`.
- GET `?token=garbage` → `{valid:false}`.
- GET `?token=<actually-issued-token>` → `{valid:true}`.

**A9. Forgot-password success echoes email (F-18)**
- Open `/ar/forgot-password`.
- Submit `samyamr819@gmail.com` (or persistent owner).
- Assert success copy contains the email verbatim, wrapped in an LTR span.

**A10. Onboarding gate on unauth user**
- GET `/ar/onboarding` (no session) → 307 → `/ar/login?next=/ar/onboarding`.

### Group B — Signup → onboarding (happy path)

Self-contained: creates a brand new tenant per test using a timestamp
stamp.

**B1. Live email-check inline indicator (AR + EN)**
- On `/ar/signup`, type the persistent owner's email →
  assert "هذا البريد مسجّل بالفعل…" appears AND Next button disables.
- Clear, type a fresh email → "متاح ✓" appears AND Next enables.
- Repeat on `/en/signup`, asserting the English strings.

**B2. Step-1 Next button states**
- Empty email → Next disabled.
- Malformed email (`x`) → Next disabled (`emailStatus === "invalid"`).
- Taken email → Next disabled.
- Valid + free email + password < 8 chars → Next enabled but
  `goToStep2` shows password error.
- Valid + free + 8-char password → advances to step 2.

**B3. Handle live check**
- On step 2, type a taken handle → assert ✗ + "هذا الاسم
  مستخدم…" + submit disabled.
- Type an invalid handle (`-foo-`) → ✗ + "حروف إنجليزية…" + example
  resets to "yourstore".
- Type a fresh handle → ✓ "متاح" + submit enabled.

**B4. Signup succeeds + auto-redirect to onboarding**
- Fill step 1 + step 2 with valid data, submit.
- Assert URL becomes `/ar/onboarding`.
- Assert session cookie present (auto-login happened).

**B5. Signup AUTO_LOGIN_FAILED panel (engineered)**
- Need to engineer a failure: easiest path is via
  `/api/__test/force-signup-bad-session` (test-only helper that flips
  a flag so the next signup's signIn returns a bad cookie). After
  signup submit, assert the "Account created, please sign in" panel
  renders with `/{locale}/login` link.

**B6. Onboarding step-1 shop-name PRE-FILL**
- After B4 navigates to `/ar/onboarding`, the shop-name input value
  equals what was typed at signup (e.g. "Coffee Lab").

**B7. Phone validation matrix**
- Empty → Next enabled.
- `01001234567` → no error, Next enabled.
- `٠١٠٠١٢٣٤٥٦٧` (Arabic-Indic) → no error, Next enabled.
- `0227777777` (Cairo landline) → no error, Next enabled.
- `not-a-phone` → error "أدخل رقماً مصرياً صحيحاً…", Next disabled.
- `01312345678` (unissued prefix) → error, Next disabled.

**B8. Step labels show "Step N of 3 · Label"**
- On AR: caption is "خطوة 1 من 3 · معلومات المتجر" at step 1,
  "خطوة 2 من 3 · اختيار البداية" at step 2, "خطوة 3 من 3 · مراجعة"
  at step 3.
- Switch language via the in-shell locale switcher (we keep it
  available even in onboarding) and re-assert English equivalents.

**B9. Step-3 tips per preset render real Links**
- Pick cornerstore preset → step 3 tips contain Links to
  `/inventory/new`, `/sales`, `/settings`.
- Back to step 2, pick blank preset → step 3 tips contain Links to
  `/settings`, `/inventory/new`, `/sales` (note different order).

**B10. Onboarding submit JWT-refresh race**
- This is the bug we fixed: the first click should land the user
  on `/`, not bounce back to the wizard.
- Fill the form, click "ابدأ" exactly once.
- Assert: `page.waitForURL("/")` resolves within 5s (no bounce).
- Assert: a session probe (`/api/auth/session`) returns
  `onboardingComplete:true`.

**B11. Onboarding gate AFTER signup but BEFORE complete**
- Sign up but DON'T fill the wizard.
- Manually navigate to `/` → bounces to `/{locale}/onboarding`.
- `/dashboard` → same. `/sales` → same. `/insights` → same.
- `/api/categories` (authenticated but not onboarded) → 403
  `{error:"ONBOARDING_REQUIRED"}`.
- `/api/auth/signout` (POST) → still 200 (allowed even when not
  onboarded).
- `/{locale}/onboarding` itself → 200 (always allowed for the
  wizard).

**B12. Onboarding refreshSession failure tolerance**
- Engineer a failure: stub `/api/auth/session` to return 500 ONCE.
  (Test-only helper or Playwright `route.fulfill` mock.)
- Submit the wizard.
- Assert: the page STILL navigates to `/` (catch + fallthrough). On
  the next page load, the middleware re-derives onboardingComplete
  from the DB → no bounce-back-to-wizard.

### Group C — Login flows

Uses the persistent test-owner account from globalSetup.

**C1. Successful login**
- `/ar/login`, fill creds, submit → `/`.

**C2. Wrong password — generic error, no leak**
- Fill correct email + wrong password → assert "البريد أو كلمة المرور
  غير صحيحة" displayed; NO "no account" hint shown.

**C3. Non-existent email — generic error + sign-up hint (F-17)**
- Fill `definitely-not-real-${stamp}@nowhere.test` + any password →
  generic error displayed AND "لا يوجد حساب…" hint with a
  `/{locale}/signup` link.

**C4. Open-redirect blocked end-to-end (A1 re-asserted with real submit)**

**C5. Middleware `next` preserves query**
- Unauthenticated GET `/dashboard?from=yesterday` → redirected to
  `/ar/login?next=/dashboard?from=yesterday`.
- Log in → land on `/dashboard?from=yesterday` (query intact).

**C6. 2FA back-button clears cached emailValue/passwordValue**
- Pre-condition: the persistent owner has 2FA enabled.
- Visit /ar/login, enter creds → 2FA prompt appears.
- Click "رجوع".
- Edit the email field to a DIFFERENT registered email + password.
- Submit → assert the precheck request body carries the NEW email
  (waitForRequest assertion).

**C7. 2FA happy path**
- Visit /ar/login, enter creds → 2FA prompt.
- Read the current TOTP code (test helper that knows the secret).
- Submit → land on `/`.

### Group D — Forgot / reset password

**D1. Forgot for unknown email — same 200 shape, mail-outbox empty**
- Submit `nobody-here-${stamp}@nowhere.test` to forgot.
- Assert success state visible.
- Poll mail-outbox: no message sent.

**D2. Forgot for known AR user — email arrives, AR template + /ar/ link**
- Persistent owner is AR.
- Submit forgot.
- Poll mail-outbox: assert one message, subject contains
  "إعادة ضبط كلمة المرور", text contains
  `http://localhost:3000/ar/reset-password?token=...`.

**D3. Forgot for known EN user — EN template + /en/ link**
- Create an EN-signup user in globalSetup (signed up at /en/signup).
- Submit forgot.
- Assert subject contains "Reset your password", link starts with
  `/en/reset-password`.

**D4. Reset with garbage token — invalid-link panel immediately**
- Visit `/ar/reset-password?token=garbage`.
- Assert: spinner briefly → "رابط غير صالح…" panel → password form
  has NEVER been rendered (`locator('input[name="newPassword"]')` →
  count 0).

**D5. Reset with valid token — full happy path**
- Extract the token from the email in D2.
- Visit `/ar/reset-password?token=<token>`.
- Form renders. Fill new password twice. Submit.
- Assert success card with "متابعة لتسجيل الدخول" button.
- Click button → `/ar/login`.
- Login with the new password → land on `/`.

**D6. Token is single-use**
- After D5, re-submit the same token to `/api/account/password/reset`
  → returns `invalid_token` error mapped to 400.

**D7. Password reset bumps token_version**
- Pre-condition: same user signed in on a second browser context.
- Complete D5 in context A.
- Context B navigates to `/dashboard` → middleware sees stale
  `tv` claim, clears session → redirects to login. (H09 invariant.)

### Group E — Locale-aware sign-up & mail

**E1. AR signup writes `users.locale='ar'`**
- After a fresh /ar/signup, hit `/api/__test/user-locale?email=...`
  (test helper) or query DB directly (db.query.users) →
  `locale === 'ar'`.

**E2. EN signup writes `users.locale='en'`**
- Same with /en/signup.

**E3. Mail template chosen from `users.locale`, not request locale**
- EN-locale user requests forgot via the AR forgot page.
- Email should STILL be English (template comes from user, not
  request).

### Group F — 2FA mutations rate-limit (F-03)

Heavy — requires owner to enable 2FA first.

**F1. Enable 2FA via /account/security**
- Pre-condition: owner logged in.
- Visit /account/security.
- Click "Enable 2FA" → secret + QR shown.
- Enter the current valid TOTP → success, recovery codes shown.

**F2. Disable 2FA with wrong TOTP — bucket consumes**
- Call POST `/api/account/2fa/disable` with correct password + wrong
  TOTP code (000000).
- Assert 400 INVALID_TOTP.
- Repeat 4 more times.
- 6th attempt → 429 `{error:"RATE_LIMITED"}`.

**F3. Disable 2FA with wrong PASSWORD — bucket also consumes**
- Same shape: wrong password + valid TOTP → 400 BAD_PASSWORD.
- 5 attempts → 6th returns 429.

**F4. Successful disable does NOT consume bucket**
- After flushing the bucket, supply correct password + correct TOTP
  → 200.
- Immediately wrong-password 5 times → ALL 400 (not 429), because
  success didn't consume.

**F5. Regenerate recovery codes — same rate-limit shape**
- 5 wrong TOTP attempts on `/api/account/2fa/regenerate` → 429.

### Group G — F-04 test-login (owner-only diagnostic)

**G1. Wrong password — wrong_password reason**
- Owner POSTs `/api/team/test-login` with a staff email + wrong
  password → `{reason:"wrong_password"}`.

**G2. Email not in owner's tenant — no_such_employee (collapsed)**
- Use the persistent-tenant-OTHER user's email + any password →
  `{reason:"no_such_employee"}` (NOT `not_in_your_tenant`).

**G3. Email nowhere on platform — no_such_employee (same shape)**
- Random `${stamp}@example.com` → `{reason:"no_such_employee"}`.
- Assert: G2 and G3 are byte-identical responses (no enumeration).

**G4. Rate limit at 11th attempt**
- 10 valid POSTs (any mix of reasons) → all 200.
- 11th → `{reason:"rate_limited"}` 429.

**G5. Rejects audit-logged**
- After G1, query the activity log
  (`/api/activity?action=team.test_login.reject`) and assert one
  entry with `metadata.reason="wrong_password"`.

### Group H — Migration / data-layer sanity

**H1. /api/account/password/forgot returns 200, not 500**
- The whole point of F-01: the `users.locale` column exists.
- Submit forgot for any email → 200 OK (whether or not the email
  exists).
- Side assertion: no `column "locale" does not exist` row in dev
  server logs since suite start.

**H2. Receipt-designer columns present (F-01 covers 0029/0030)**
- Visit `/settings/receipt-designer` (when authenticated). Page
  renders without 500 — column existence checked implicitly.

### Group I — Sentry scrubber (F-02)

**I1. Scrubber unit test**
- Pure-JS test of `scrubSentryEvent` + `scrubSentryBreadcrumb`
  from `lib/sentry/scrub.ts`. Should live in `tests/` (vitest), not
  Playwright. Already noted as a follow-up to the unit suite.

(Group I not run inside Playwright — listed for completeness.)

---

## 4. Test data + isolation

- **Per-run stamp**: `const STAMP = Date.now()`. All created emails,
  handles, tenant names use this. Two parallel runs cannot collide.
- **Persistent test-owner**: one account per locale (`perma-owner-ar@matgary.test`,
  `perma-owner-en@matgary.test`), created on first run and reused.
  Globalsetup creates if missing; subsequent runs use the existing
  one. Password documented in the test source.
- **2FA test owner**: a separate persistent owner with 2FA enabled.
  Created in globalSetup with a known secret saved to a JSON file in
  `tests/e2e/fixtures/` so the suite can generate valid TOTPs at
  test time using `lib/totp.ts`.
- **Cleanup**: NONE. Test-created tenants accumulate. Document the
  cleanup script (`scripts/wipe-test-tenants.ts`) but don't auto-run
  it — too many ways for it to drop real data by mistake.

## 5. Mailer interception

Two acceptable strategies; pick one:

**Strategy A — MailHog**
- `docker compose up mailhog` (already in compose).
- `SMTP_HOST=localhost SMTP_PORT=1025` in `.env.test.local`.
- Read inbox via `http://localhost:8025/api/v2/messages?limit=10`.

**Strategy B — In-memory outbox stub**
- New file: `lib/mailer-stub.ts` (only active when
  `NEXT_PUBLIC_TEST_MODE=1` — same env-gated approach as Sentry).
- `lib/mailer.ts` delegates to the stub when active.
- Stub appends to an in-memory array; exposed read-only at
  `/api/__test/mail-outbox`.
- `/api/__test/*` is gated by middleware: only respond when
  `process.env.NEXT_PUBLIC_TEST_MODE === "1"`, otherwise 404.

I prefer **B** because MailHog adds infrastructure to the test
prerequisites. B is one extra source file + middleware allowlist
entry, deletable by greppable convention if anyone questions it.

## 6. `/api/__test/*` test-only helpers

Behind `NEXT_PUBLIC_TEST_MODE=1`, exposed for the suite only:

- `GET /api/__test/mail-outbox` — last 50 outbound mails (subject,
  to, text, html).
- `POST /api/__test/mail-outbox/clear` — flushes the in-memory list.
- `GET /api/__test/user-locale?email=…` — returns `{locale}` for a
  user; saves the suite from running DB-side queries.
- `GET /api/__test/totp-secret?email=…` — returns the user's TOTP
  secret in plaintext (TEST ONLY — only persistent test users
  whose passwords are also in the source code anyway).
- `POST /api/__test/rate-limit/clear?scope=…` — flushes one bucket
  (lets F-series tests reset between cases without `redis-cli`).
- `POST /api/__test/migrations/verify` — re-runs the migrator and
  asserts no "Migrations complete." preceded by an ERROR notice
  (defensive check that F-01 stays closed).

**ALL of these are 404 unless `NEXT_PUBLIC_TEST_MODE === "1"`.** The
suite refuses to run if the env var isn't set on the server it's
talking to. Documented loudly in the file headers.

## 7. Rate-limit testing strategy

Some tests intentionally trip rate limits. Resetting between cases:

- `/api/__test/rate-limit/clear?scope=auth.totp.account_mut&id=<userId>`
- `/api/__test/rate-limit/clear?scope=team.test_login&id=<userId>`
- `/api/__test/rate-limit/clear?scope=auth.email_check&id=<ip>`

If `NEXT_PUBLIC_TEST_MODE` is off, the suite falls back to wall-clock
waits or `docker exec redis-cli FLUSHDB` (slower, kills all buckets
including unrelated ones).

## 8. Run instructions

```bash
# One-shot setup (idempotent)
docker compose up -d postgres redis
npm run db:migrate

# Start the server with test-mode helpers enabled
NEXT_PUBLIC_TEST_MODE=1 npm run dev

# In another terminal, run the suite against the running server
PLAYWRIGHT_NO_WEBSERVER=1 \
  PLAYWRIGHT_BASE_URL=http://localhost:3000 \
  npx playwright test tests/e2e/heavy.spec.ts
```

For CI, the existing `playwright.config.ts` `webServer` block builds
+ starts on :3100. Add `NEXT_PUBLIC_TEST_MODE=1` to that env.

## 9. Pass / fail criteria

The suite passes only when **every test** passes. No `.skip`
allowed in a green run (skipping is a regression of its own).

Acceptable failures (document at the top of the spec file) only:
- MailHog unavailable AND strategy A was chosen → email tests skip
  with a loud warn (not pass).

## 10. Estimated runtime

| Group | Tests | Wall time |
| --- | --- | --- |
| A | 10 | ~10s |
| B | 12 | ~50s (includes signup × ~4 fresh tenants) |
| C | 7 | ~25s (includes 2FA enable + login dance) |
| D | 7 | ~30s |
| E | 3 | ~5s |
| F | 5 | ~25s (rate-limit + 2FA dance) |
| G | 5 | ~10s |
| H | 2 | ~5s |
| **Total** | **51** | **~3 min** warm, ~5 min cold |

Sequential within groups (`mode: "serial"`); groups parallelizable in
the future when we widen the worker pool.

## 11. File layout

```
tests/e2e/
  heavy.spec.ts           — the suite (new — large file, ~600 lines)
  global-setup.ts         — Redis flush, dev-server ready check, persistent users
  fixtures/
    perma-users.json      — handles + secrets for persistent test owners
  helpers/
    api.ts                — typed wrappers for /api/__test/*, mail outbox poll
    totp.ts               — generate current TOTP from a stored secret
    test-data.ts          — STAMP, fresh email/handle generators
lib/
  mailer.ts               — modified: delegate to stub when TEST_MODE
  mailer-stub.ts          — new — in-memory outbox
app/api/__test/
  mail-outbox/route.ts    — GET + POST clear
  user-locale/route.ts    — GET
  totp-secret/route.ts    — GET (gated)
  rate-limit/clear/route.ts
  migrations/verify/route.ts
middleware.ts             — modified: 404 every /api/__test/* unless TEST_MODE
```

## 12. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| `/api/__test/*` accidentally enabled in prod | Middleware hard-blocks unless `NEXT_PUBLIC_TEST_MODE === "1"`. Build-time check in `next.config.ts` could `throw` if `TEST_MODE` is set in `NODE_ENV=production`. |
| Test-created tenants accumulate forever | Document the wipe script. Periodically run via a manual `npm run test:wipe`. Not auto-run by suite. |
| Rate-limit bucket contention with manual dev work in parallel | Suite runs in serial mode and is the only writer to its scoped buckets. If a developer's manual browser shares the IP, the `email_check` 60/min test may be flaky. Document: don't browse while the heavy suite runs. |
| Playwright + Next dev cold compile spike | First test in each group warms its route via a no-op visit. Acceptable: +15-30s on first cold run, none thereafter. |
| MailHog port collision with another service | Default port 8025 documented; failure mode is loud (suite asserts `/messages` returns 200 at startup). |

## 13. Acceptance for this spec

When you've reviewed, your "go" means:

1. Strategy B (in-memory outbox + `/api/__test/*`) is acceptable.
2. ~51 tests / ~3 min runtime is acceptable.
3. The test-mode env-gate (`NEXT_PUBLIC_TEST_MODE`) is acceptable
   instead of a separate test build.
4. The persistent test-owner approach (one per locale + one 2FA
   owner) is acceptable. The credentials live in
   `tests/e2e/fixtures/perma-users.json` (NOT committed if you
   prefer — but recommended to commit for reproducibility, since
   they're test-only).
5. The list of `/api/__test/*` helpers is acceptable.

If anything is off, name what and I'll revise the spec before
writing code.

---

## Open questions for Amr

1. **MailHog or stub?** I lean stub. You?
2. **`/api/__test/*` env-gate vs separate test build?** I lean
   env-gate (simpler).
3. **Commit `perma-users.json`?** I lean yes — test passwords aren't
   secrets.
4. **Run modes**: just `npm run dev`-based, or also wire into
   `playwright.config.ts` webServer for CI? Both is fine — just say.
5. **Should the suite write to `task.md`** as a "test-coverage
   audit" entry, or stay self-contained under `docs/specs/`?
