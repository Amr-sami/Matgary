# Security Review — Validation Pass

Follow-up to `security-review-report.md`. Re-read each of the 8 named
findings against ground-truth source. **Three findings retract,
three soften, two stand.** Launch-priority remediation plan at end.

---

## Validation grades

### F-02 — Sentry `beforeSend` scrubber

- **Status**: ✅ confirmed (config absent), 🟡 not actively exploited
- **Source verification**: `sentry.server.config.ts` 16 lines; `sentry.client.config.ts` 12 lines. Neither defines `beforeSend`, `beforeBreadcrumb`, `ignoreErrors`, or a sanitizer. Both only set DSN, environment, sampler, and (client) replay.
- **Exploitability**: **Conditional**. Today no code path in the audited surface logs request bodies, password fields, or session cookies. Active credential routes (`password/forgot`, `password/reset`, `2fa/*`, login provider) return mapped errors, not raw `err` objects, so Sentry breadcrumbs don't carry secrets. The exposure is *prospective*: any future careless `console.error(req)` / `Sentry.captureException(err, {extra: req})` becomes a silent password leak.
- **Likelihood**: Low today, growing over time as the codebase evolves.
- **Business impact**: High if it ever fires (passwords, 2FA codes, session tokens land in a third-party SaaS observable by anyone with a Sentry seat).
- **Effort**: **Low** (single config addition, code provided in the original report).
- **Recommended timing**: **First post-launch sprint.** Not a launch blocker, but cheap insurance and trivial to add now.

### F-03 — 2FA disable / regenerate TOTP brute-force

- **Status**: ✅ confirmed (no per-actor rate limit on the route or repo)
- **Source verification**: `lib/repo/account-security.ts` `disable2fa()` and `regenerateRecoveryCodes()` both follow the sequence `bcrypt.compare(password) → verifyTotp(token)` with no `rateLimit` / `rateLimitConsume` call. Route handlers also don't add one.
- **Critical context I missed in the original write-up**: **bcrypt password check runs *before* the TOTP check.** An attacker without the user's password gets `BAD_PASSWORD` on every attempt and never reaches the TOTP brute-force window. So the TOTP-1M-tries window only opens once the attacker already has the password AND a valid session.
- **Exploitability**: **Conditional** — requires *already-compromised credentials and a hijacked session* to reach the TOTP guess loop. At that point the attacker has most of the account; the only thing 2FA still blocks is sign-in from a *new* device.
- **Likelihood**: Low. Real-world chain: phishing site collects password + session → attacker logs in on the victim's machine (session works) → tries to disable 2FA before victim notices → with no rate limit, brute-forces TOTP in seconds. Plausible, not common.
- **Business impact**: Account takeover persistence — once 2FA is off, the attacker survives a password reset of the victim if they retain the session.
- **Effort**: **Low** (15-line rate-limit wrap — code in original F-03).
- **Recommended timing**: **First post-launch sprint.** Defensive depth on a real chain, but not the most likely path. The post-1M-tries time-cost (with bcrypt cost 12) is ~hours per attempt, not seconds; ranking it Medium.
- **Downgrade**: High → **Medium**.

### F-04 — `/api/team/test-login` credential oracle

- **Status**: ✅ confirmed
- **Source verification**: `app/api/team/test-login/route.ts:27-91`. Permission gate is `requirePermission("manage_team")` (owner-bypasses, staff with the perm also reach it). Bcrypt comparison runs unconditionally on every call. Three distinct reason codes leak: `user_not_found` (email unknown platform-wide), `not_in_your_tenant` (email registered, just not yours), `wrong_password` (yours, wrong creds).
- **Exploitability**: **Definitely exploitable as a brute-force oracle for the caller's own tenant**, conditionally as a platform-wide email-enumeration tool. Both require a logged-in user with `manage_team` perm — typically the owner.
- **Likelihood**: Low unless an owner session is compromised (XSS, shared laptop, password reuse).
- **Business impact**: Medium — leaks staff passwords from common-password lists, enables platform-wide email enumeration. No cross-tenant *data* access, no privilege escalation, no financial impact.
- **Effort**: **Low** (per-actor rate-limit + collapse the two "no match" reasons into one).
- **Recommended timing**: **First post-launch sprint.** Owner self-service tool; legitimate use is rare. Combined fix is ~10 lines.

### F-05 — `/api/uploads/team/[...path]` read-path traversal / IDOR

- **Status**: ❌ **RETRACT.** Properly hardened end-to-end.
- **Source verification**: `app/api/uploads/team/[...path]/route.ts`:
  - `requirePermission("manage_team")` gates auth + perm (line 17).
  - First path segment compared to caller's tenantId — 403 if mismatch (line 26-28). **IDOR closed.**
  - `resolveTenantUpload(r.ctx.tenantId, relativePath)` re-derives the absolute path inside the tenant directory using `path.resolve` + `startsWith` check (in `lib/uploads.ts:99-112`). **Path traversal closed.**
  - `stat()` then `readFile()` only against the resolved absolute path. No string concatenation into a filesystem path.
- **My original report flagged this as "needs verification."** Verified — it's correct.
- **No fix needed.**

### F-06 — `/api/products/import` CSV size + injection

- **Status**: 🟡 partially retract. Size + parse risks already addressed. **CSV injection on re-export remains.**
- **Source verification**: `app/api/products/import/route.ts`:
  - Zod schema bounds CSV at `max(2 * 1024 * 1024)` — 2 MB hard cap. **OOM risk closed.**
  - Body is JSON-wrapped, not multipart — no streaming parse needed. **Megabyte fan-out closed.**
  - `requireTenantWithBranch()` + `can(r.ctx, "manage_inventory")` permission gate. **Authz correct.**
  - Two-phase preview / commit pattern — operator sees the plan before write. **Defensive.**
  - Activity log captures rows / created / updated / failed (line 64-77).
- **What I missed**: original report said "no visible MIME / size enforcement." It's not multipart, so no MIME; the size cap is at the Zod string length. Both checks are present.
- **What remains**: **CSV injection on re-export**. If imported product names start with `=`, `+`, `-`, `@`, downstream exports re-emitting them into Excel/Sheets execute formulas in the recipient's machine. The import endpoint does not deformulize.
- **Exploitability**: **Conditional** — requires the attacker to have `manage_inventory` permission (staff with that role) and the tenant to ever export inventory to CSV/XLSX. Triggered in the *export consumer's* machine, not the platform.
- **Likelihood**: Low. Tenant exporting their own data to Excel is a common workflow but the attacker would need to be malicious staff who anticipate this.
- **Business impact**: Phishing/RCE on the *exporting user's* desktop — outside the platform but reputationally bad if a customer hits it.
- **Effort**: **Low** — one helper added at every export point, ~5 lines:
  ```ts
  function deformulize(cell: unknown): string {
    const s = String(cell ?? "");
    return /^[=+\-@]/.test(s) ? `'${s}` : s;
  }
  ```
- **Recommended timing**: **Backlog.** Address when the next export endpoint is added, or all-at-once via a shared `exportCsv()` utility.
- **Downgrade**: Medium → **Low**.

### F-07 — `/api/account/password` rate limiting

- **Status**: ❌ **RETRACT.** Already rate-limited.
- **Source verification**: `app/api/account/password/route.ts:29-38`:
  ```ts
  const limit = await rateLimit("pwd.change", r.ctx.userId, {
    limit: PWD_CHANGE_LIMIT,  // 5
    windowSec: PWD_CHANGE_WINDOW_SEC,  // 3600
  });
  if (!limit.ok) {
    return NextResponse.json({ error: "..." }, { status: 429 });
  }
  ```
- **My original audit missed this entirely.** The route has the exact bucket I would have recommended.
- **No fix needed.**

### F-08 — WhatsApp send endpoints abuse controls

- **Status**: 🟡 partially retract. All routes ARE rate-limited; per-recipient cap is the only remaining gap, and only for non-OTP.
- **Source verification**: All five non-webhook send routes share the `wa.send` bucket (`30 / minute / tenant`). The OTP route has two tighter buckets: `wa.otp.phone` (5 / 15 min per `(tenant, branch, phone)`) and `wa.otp.tenant` (60 / hour per tenant).
- **What I missed**: the existence of `wa.send` and the OTP-specific buckets. Original audit claim "no per-tenant rate limit" was wrong.
- **What remains**: non-OTP routes have no per-*recipient* cap. A compromised tenant session can send 30 messages a minute to 30 different victims, fanning out for harassment/spam without tripping the bucket. The OTP route already addresses this; the general send routes don't.
- **Exploitability**: **Conditional** — requires a compromised tenant session AND intent to harass. The tenant pays for their own quota, so financial impact lands on them; harassment impact lands on the recipient.
- **Likelihood**: Low.
- **Business impact**: Tenant's Meta number flagged by recipients, possibly leading to Meta-side restriction of that WABA number. Reputational, not catastrophic.
- **Effort**: **Low** — add a per-recipient bucket alongside the existing per-tenant one (12 lines).
- **Recommended timing**: **Backlog.** OTP — the most-abuse-prone channel — is already correctly bucketed. The remaining gap is low-impact.
- **Downgrade**: Medium → **Low**.

### F-09 — Webhook replay authorization

- **Status**: ❌ **RETRACT.** Owner-gated and idempotency-safe.
- **Source verification**: `app/api/whatsapp/webhook/events/[id]/replay/route.ts`:
  - `requireTenantWithBranch()` (line 34) + explicit `auth.ctx.role !== "owner"` check returning 403 (line 36-41). **Owner-only.** I previously said "needs a permission gate"; it has a stricter role gate.
  - **Idempotency built in**: line 56-61 rejects replay unless `row.processingStatus === "quarantined"`. Already-processed events cannot be replayed, period. My "could re-fire side effects" attack scenario is impossible.
  - Distinct audit trail: `logger.info({ event: "wa.webhook.replay.requested", eventId, requestedByUserId, requestedByTenantId })` (line 63-68). Replays are traceable in logs.
- **No fix needed.**

---

## Re-graded scoreboard

| F-# | Original | Validated | Fix |
| --- | --- | --- | --- |
| F-02 | High | **Medium** — config gap, no active leak path | Sprint 1 |
| F-03 | High | **Medium** — needs prior credential compromise | Sprint 1 |
| F-04 | Medium | **Medium** (confirmed) | Sprint 1 |
| F-05 | Medium | **Retracted** — properly defended | — |
| F-06 | Medium | **Low** — only CSV-on-export injection remains | Backlog |
| F-07 | Medium | **Retracted** — rate limit already exists | — |
| F-08 | Medium | **Low** — only per-recipient gap for non-OTP | Backlog |
| F-09 | Medium | **Retracted** — owner gate + quarantine-only | — |

**Three retractions** (F-05, F-07, F-09), **two downgrades** (F-06 → Low, F-08 → Low), **one effective downgrade** (F-02 keeps the gap but the active risk is lower than the original write-up implied), **two confirmed** (F-03, F-04).

---

## Risk-category ranking

### Account takeover (real chains, ranked)

1. **F-03** — Post-credential-compromise persistence. Attacker who has both password and session can disable 2FA via unbounded TOTP brute. Single chain item to fix the persistence gap.
2. **F-04** — Owner-session-compromise bcrypt oracle. Lets an attacker on a compromised owner cookie crack staff passwords from leaked password lists. Indirect — escalates within the same tenant once an owner is already breached.

**No pre-auth account takeover path was found.** The login flow's combined bcrypt + TOTP + per-IP + per-email + per-user rate limits hold.

### Cross-tenant access

**None found.** Postgres FORCE RLS, transaction-scoped `app.tenant_id`, `withTenant` wrappers, and `requireTenantWithBranch` together provide a defense-in-depth model. F-04 leaks platform-wide email *existence* to logged-in owners (enumeration), not any tenant data.

### Privilege escalation

**None found.** Permission model uses `requirePermission(perm)` consistently; owner role bypasses individual perm checks but is itself the highest level. No staff role can self-promote.

### Financial abuse

1. **F-08** (downgraded to Low) — compromised tenant session can spend WhatsApp Cloud / Green API quota at 30 msg/min × 60 min × 24 = ~43,000 messages/day. Tenant pays. Limited recipient diversity (one bucket per tenant, not per recipient) makes it more useful for harassment than for fraud.
2. **`/api/billing/cancel`** — owner-only; not a cross-tenant or escalation vector. No finding.
3. **`/api/customers/by-phone/[phone]/mark-all-paid`** (called out in surface map, not in original findings) — staff can mark debt as collected with no monetary log. Worth a follow-up but no compromise vector found in this pass.

**No platform-side financial loss vector** (the SaaS itself isn't charged for tenant overuse; tenants are).

### Regulatory exposure (PDPL)

1. **F-02** — Sentry could ingest PII (national IDs, customer phones, employee photos via accidental log) the day someone adds a careless `console.error(req.body)`. The PDPL processor obligation requires reasonable safeguards against this; an empty `beforeSend` doesn't meet "reasonable."
2. **F-13 from original report** (attendance geo retention undocumented) — also PDPL-relevant. Not in this validation pass but worth flagging.

---

## Launch-priority remediation plan

### Before launch — blocking

1. **F-01 from original report (NOT in this validation list but the actual blocker)** — Reconcile migrations 0029, 0030, 0031 into `_journal.json`. **This is the only finding that will *definitely break in production* on the next deploy.** Without it, the locale-aware reset email I just shipped throws a 500 in any fresh environment.

That's it. No other finding from this set is launch-blocking.

### First post-launch sprint

In this order (each ~30-60 min of work):

2. **F-02** — Add `beforeSend` scrubber to both Sentry configs. Code in original report §F-02. PDPL hygiene.
3. **F-03** — Add `auth.totp.account_mut` per-user rate-limit bucket to `disable2fa` + `regenerateRecoveryCodes`. Closes the one real ATO-persistence chain item.
4. **F-04** — Add `team.test_login` per-user rate limit + collapse the `user_not_found` / `not_in_your_tenant` distinction into one reason. Closes the bcrypt oracle and the platform-wide email enumeration leak in one patch.

Total Sprint-1 surface: 3 small PRs, ~80 lines added across 5 files. All low-risk.

### Backlog

5. **F-06** — Add a shared `deformulize` helper applied at every CSV export sink. Bundle when the next export endpoint is added.
6. **F-08** — Add per-recipient rate-limit bucket to non-OTP send routes. Bundle into the next WhatsApp-related task.

---

## Closing assessment

The codebase is **launch-ready from a security standpoint** once F-01 (migration journal) is reconciled. None of the validation-pass findings represent a pre-auth compromise, cross-tenant breach, or unauthenticated data exposure. The Sprint-1 items close defense-in-depth gaps on already-narrow chains. The Backlog items are hardening, not vulnerabilities.

The pre-pentest hardening pass (H07, closed June 3) and the subsequent auth-flow audit (closed June 7) did real work — the validation here mostly confirms that work landed correctly, and corrects three findings in my previous report where I missed existing controls.

---

## Closure (2026-06-07)

Audit closed by owner. All four agreed items shipped in a single
batch (one commit). Status:

| Item | Status | Where it landed |
| --- | --- | --- |
| F-01 — Migration journal drift | **Fixed** | `lib/db/migrations/meta/_journal.json` extended with idx 29/30/31; `0031_user_locale.sql` constraint wrapped in a `DO $$ IF NOT EXISTS ... $$` block so re-runs on partially-applied envs are idempotent. `npm run db:migrate` now succeeds end-to-end. |
| F-02 — Sentry scrubber | **Fixed** | New `lib/sentry/scrub.ts` exports `scrubSentryEvent` + `scrubSentryBreadcrumb`. Both Sentry configs (`sentry.server.config.ts`, `sentry.client.config.ts`) wire them as `beforeSend` + `beforeBreadcrumb`. Redacts sensitive headers (Authorization, Cookie, X-CSRF-Token, etc.), sensitive body keys (password / totp / secret / token / code / recovery / ...), `extra` / `contexts`, and sensitive query params on URL-bearing breadcrumbs. |
| F-03 — 2FA disable/regenerate TOTP brute-force | **Fixed** | New `auth.totp.account_mut` rate-limit bucket (5 attempts / 15 min / user) wired inside `lib/repo/account-security.ts` so any caller of `disable2fa` or `regenerateRecoveryCodes` benefits. New `TotpRateLimitedError` mapped to HTTP 429 by both route handlers. Bucket consumed only on `BAD_PASSWORD` / `INVALID_TOTP` failures so a legitimate user with a single typo doesn't lock themselves out. |
| F-04 — `/api/team/test-login` oracle + enumeration | **Fixed** | New `team.test_login` rate-limit bucket (10 attempts / hour / caller). The `user_not_found` and `not_in_your_tenant` responses collapsed into a single `no_such_employee` reason — platform-wide email enumeration via this endpoint is now neutralized. Every reject is recorded to `activity_logs` with category=`auth` and a `reason` metadata field so abuse patterns surface in audit review. |

**Verification**
- `npm run db:migrate` → "Migrations complete." on the dev DB; `users.locale` + `users_locale_chk` + the three new `shop_settings` columns all present (verified via `psql`).
- `npx tsc --noEmit` → clean.
- Existing unit suite (`tests/{url-safe,i18n-config,mail-password-reset,egypt-phone}.test.ts`) → 41/41 passing.

**Carried forward into backlog** (acceptable as documented):
- F-06 (CSV export deformulize helper) — bundle when next export ships.
- F-08 (per-recipient WhatsApp send bucket) — bundle into next WA task.
- Original-report Low findings (F-10..F-20) — track in `task.md`
  alongside the existing H-series.

**Audit closed.** No outstanding launch blockers.
