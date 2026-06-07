# Security Review — Methodology & Scope

Owner: Amr · Reviewer: Senior AppSec / Pentest engagement
Drafted: 2026-06-07

Companion to the deliverable `security-review-report.md`. Documents
**what** is being reviewed, **how**, and **why** — so the findings
report can stay tight and reference this for context.

---

## 1. Reviewer mode

External penetration tester + defensive AppSec engineer. Assumes the
application is publicly exposed on the internet. No insider context
beyond the source code, schema, and shipped specs. No production
credentials.

**Goal**: identify vulnerabilities, insecure patterns, missing
controls, privilege-escalation paths, hardening gaps.

**Non-goals**: exploitation, offensive PoC code, anything that would
modify production. All findings are defensive recommendations.

## 2. Threat model

### Trust boundaries

| # | Boundary | Trusted side | Untrusted side |
| --- | --- | --- | --- |
| TB1 | Browser ⟷ HTTPS edge | Server | Browser, network |
| TB2 | Public API ⟷ logged-in handler | Authenticated session | Request body, query, headers |
| TB3 | Tenant A ⟷ Tenant B (RLS) | Postgres role + `app.tenant_id` | Anything bypassing `withTenant` |
| TB4 | Owner ⟷ staff (permissions) | `tenant_members.role` + `permissions` | Staff-issued requests |
| TB5 | Application ⟷ Redis | Code that calls `cacheRemember` | Anyone who can reach Redis |
| TB6 | Application ⟷ Postgres | Drizzle layer | Anyone who can reach Postgres |
| TB7 | App ⟷ external (WhatsApp webhook, Paymob, Sentry) | Verified inbound | Spoofed inbound |

### Threat actors

1. **Unauth attacker** on the internet — wants tenant data, account
   takeover, free service abuse.
2. **Authenticated tenant staff** — wants to escalate role, access
   other tenants, exfiltrate beyond their permission set.
3. **Compromised tenant owner** account — already has full access to
   one tenant; wants to pivot to another tenant or take down the
   platform.
4. **Insider on infra** — out of scope for this review (separate
   physical-access threat model).

### Crown jewels

In rank order of value to defender:

1. `users.password_hash`, `users.totp_secret`, `users.recovery_codes_hash`,
   `users.token_version` — auth credentials.
2. Cross-tenant data — `tenants`, `tenant_members`, all RLS-protected
   tables (`sales`, `customers`, `expenses`, `inventory`, etc.).
3. `wa_connections` access tokens — WhatsApp Business API tokens
   capable of sending messages on behalf of the tenant.
4. Activity log — tampering would erase audit trail.
5. PDPL-protected PII — national IDs, employee photos, customer
   contact info.

## 3. Scope

### In scope

- `middleware.ts`
- `app/[lang]/(auth)/**` — signup, login, forgot, reset, onboarding
  actions and pages
- `app/api/**` — every route handler (REST + auth callbacks + webhooks)
- `lib/auth*.ts`, `lib/auth.config.ts`
- `lib/db/**` — schema, migrations, RLS, query layer, `withTenant`
- `lib/repo/**` — repositories that touch sensitive data
- `lib/mail/**`, `lib/mailer.ts` — transactional email
- `lib/redis.ts`, `lib/cache.ts`, `lib/ratelimit.ts`
- `lib/validators/**`
- `lib/permissions.ts` — RBAC
- Server actions referenced from `[lang]/(auth)`, `(app)/...`
- Recent additions: i18n stack (`lib/i18n/**`, `dictionaries/**`,
  `components/i18n/**`), auth-hardening work (`lib/url-safe.ts`,
  `lib/mail/password-reset.ts`, `0031_user_locale.sql`).
- Pre-existing uncommitted work that's on the working tree:
  `app/purchases/page.tsx`, `components/purchases/**`,
  `app/api/purchase-orders/[id]/payments/**`,
  `components/settings/ReceiptDesigner.tsx`,
  `lib/repo/purchase-payments.ts`,
  migrations `0025_purchase_payments.sql`, `0029_receipt_designer.sql`,
  `0030_receipt_custom_blocks.sql`.

### Out of scope

- The pre-pentest hardening report `infra/pre-pentest-audit.md` —
  findings there are accepted unless I find a regression.
- The `infra/` shell scripts, nginx config, Docker compose — assumed
  reviewed by ops. Touched only when a finding implies a config gap.
- Sentry config beyond verifying secrets aren't leaked.
- Tests under `tests/**` — not user-facing.
- Third-party packages' internal vulnerabilities — covered by
  `npm audit` summary only.

## 4. Audit dimensions

Each finding will be tagged with the cell(s) it lands in.

| Bucket | Sub-dimensions |
| --- | --- |
| **AUTHN** | Bypass · session fixation · JWT · password policy · enumeration · brute-force · MFA/TOTP · password-reset · open-redirect |
| **AUTHZ** | BAC · IDOR · horizontal/vertical escalation · tenant isolation · multi-tenant leakage |
| **DB** | SQLi · NoSQLi · unsafe dynamic queries · raw SQL · ORM misuse · parameterization · DB perms |
| **INPUT** | Stored/Reflected/DOM XSS · HTML/Markdown/CSV injection · command injection · path traversal · prototype pollution |
| **API** | Rate limits · validation · mass assignment · sensitive disclosure · excessive data exposure · missing authz |
| **FILE** | Unsafe uploads · MIME bypass · extension whitelist · malware · storage perms |
| **CSRF/BROWSER** | CSRF · SameSite · Origin checks · CSP · headers · clickjacking |
| **INFRA** | Secrets exposure · env leaks · debug mode · sensitive logging · CORS |
| **NEXT.JS** | Server Actions · middleware · route handlers · auth callbacks · client/server boundary · sensitive hydration |
| **DEPS** | Known vulnerable · outdated · dangerous packages |

## 5. Methodology

1. **Surface mapping** — enumerate every entry point: route handlers,
   server actions, middleware, scheduled jobs (`api/cron/**`),
   webhooks, public endpoints (`PUBLIC_PATHS` / `PUBLIC_PREFIXES` in
   `middleware.ts`).
2. **Auth gate audit** — for each authenticated entry, verify the
   gate. For each public entry, verify the rationale is documented and
   abuse-protected (rate limit, sig check, idempotency).
3. **Authorization sweep** — for each handler that loads tenant-scoped
   data, verify the load goes through `withTenant` (or equivalent)
   AND the explicit ownership check matches the caller's tenant
   (defense in depth on top of RLS).
4. **Input validation** — every `formData.get`, `req.json`,
   `searchParams.get`, header read → must be Zod-validated or
   primitive-coerced. Flag anything spread into a DB insert
   ("mass assignment"). Flag string concatenation into URLs, file
   paths, or commands.
5. **Database** — grep for `sql.raw`, `sql\``, `Drizzle.sql`, manual
   parameter interpolation. Validate every `.where()` predicate uses
   parameterized columns, not string concatenation.
6. **XSS sweep** — grep `dangerouslySetInnerHTML`, `innerHTML =`,
   `eval`, `new Function`. Verify any HTML render escapes user input.
   Markdown/HTML stored on `tenants.*` or `shop_settings.*` rendered
   in receipts or public catalog → high risk.
7. **CSRF posture** — confirm SameSite + Origin / Referer checks on
   state-changing routes. Confirm Server Actions trust boundary.
   Confirm webhook routes verify HMAC.
8. **Headers** — pull a sample request, verify CSP, X-Frame-Options,
   HSTS (via nginx), Referrer-Policy, Permissions-Policy.
9. **Headless inspection** — visit each public-facing route, look at
   the response for stack traces, internal IDs, debug info, version
   leaks.
10. **Secrets review** — grep the codebase for secret-looking strings,
    `process.env.*` defaults, `console.log(*token*)`,
    `console.log(*password*)`.
11. **Dependency audit** — `npm audit` summary + manual check of any
    package known to be at risk (e.g., `bcryptjs` constant-time,
    `postgres` library version, `jose` version, `next-auth` beta).

## 6. Output format

Single report at `docs/specs/security-review-report.md`. Sections:

1. Executive summary (one page).
2. Critical findings (each in the template below).
3. High severity findings.
4. Medium severity findings.
5. Low severity findings.
6. Hardening recommendations (no finding required; just "should").
7. Production readiness score (0–100) + breakdown by dimension.
8. OWASP Top 10 (2021) coverage table.
9. Multi-tenant security assessment (RLS + perm checks).
10. Authentication & session security assessment.

### Finding template

```
### F-NN — Title

**Severity**: Critical | High | Medium | Low
**Dimension(s)**: AUTHN · AUTHZ · DB · ...
**Affected**: `path/file.ts:LL-LL`
**OWASP**: A01-Broken Access Control | ...

**Vulnerability**
What's wrong, in one paragraph.

**Attack scenario**
Step-by-step. Be concrete: "Attacker A is an authenticated staff
member of tenant T1. They..."

**Why current implementation is vulnerable**
The specific code path that fails the check.

**Remediation**
The fix in one paragraph.

**Production-grade code example**
```ts
// before
...
// after
...
```
```

## 7. Severity rubric

- **Critical** — Pre-auth or one-click compromise of any tenant,
  cross-tenant data read or write, credential exfiltration, or
  RCE. Patch within 24 hours.
- **High** — Authenticated escalation across tenants or roles, mass
  data disclosure, password-reset bypass, persistent XSS in a
  privileged surface, unauthenticated DoS amplification. Patch in
  the next sprint.
- **Medium** — Logged-in IDOR with auditable trail, weak rate
  limiting, missing security header that browsers still partly
  enforce, error-message leakage that helps enumeration. Patch in
  the next release.
- **Low** — Hardening gap, defense-in-depth opportunity,
  documentation drift, minor disclosure of non-secret detail.
  Track and bundle.

## 8. Process

1. Write this spec (done).
2. Map attack surface in parallel via Explore agents.
3. Read specific high-value files directly.
4. Synthesize findings into the report.
5. Score each dimension.
6. Commit both spec and report; do not push code changes —
   report is read-only deliverable.
