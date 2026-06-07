# Security Review — Matgary

Companion to `security-review-spec.md`. Reviewer: senior AppSec /
pentest engagement, defensive only. Drafted: 2026-06-07.

---

## 1. Executive summary

Matgary is in **strong** baseline shape. The H01–H12 hardening sprint
(closed June 3) produced a mature multi-tenant posture: forced Postgres
RLS on every tenant-scoped table, transaction-scoped `app.tenant_id`,
NextAuth v5 JWT with a per-user `token_version` revocation channel,
per-request CSP nonce, constant-time webhook HMAC verification, and
14 rate-limit buckets across the auth + abuse surface. Recent i18n +
auth-hardening work (16 audit items shipped between June 6 and June 7)
closed a real open-redirect, removed Arabic literals from server-side
error returns, made the password-reset email locale-aware, and added
pre-validation of reset tokens.

**No critical (pre-auth or one-click compromise) vulnerabilities
found.** Three High-severity findings concern release-process drift,
observability data leakage, and a 2FA brute-force window. Six Medium
findings cluster around credential oracles, file upload allowlist
enforcement, and missing rate limits on sensitive mutations. The
Low/Hardening section captures defense-in-depth opportunities.

**Production-readiness score: 82 / 100.** Detailed breakdown in §7.

The single most important action is **reconciling migrations 0029,
0030, 0031** (uncommitted on the working tree, not in
`lib/db/migrations/meta/_journal.json`) before any new deploy. The
Drizzle migrator only runs journaled entries, so a fresh production
environment will silently miss the schema changes those features
depend on.

---

## 2. Critical findings

**None.**

The audit found no pre-auth RCE, no SQL injection, no cross-tenant
data read/write, no credential exfiltration, no broken access control
of the kind that exposes one tenant's data to another, and no missing
authentication on a sensitive mutation. The architecture's reliance
on Postgres RLS + transaction-scoped `app.tenant_id` + explicit
permission gates produces a strong worst-case posture even if one
layer fails.

---

## 3. High-severity findings

### F-01 — Migration journal drift: 0029, 0030, 0031 ship code that production may never apply

**Severity**: High
**Dimension**: DB · INFRA
**Affected**: `lib/db/migrations/0029_receipt_designer.sql`,
`lib/db/migrations/0030_receipt_custom_blocks.sql`,
`lib/db/migrations/0031_user_locale.sql`,
`lib/db/migrations/meta/_journal.json`
**OWASP**: A05-Security Misconfiguration

**Vulnerability**
Three migration SQL files exist on disk but are absent from
`_journal.json`. Drizzle's migrator (`lib/db/migrate.ts`,
`drizzle-orm/postgres-js/migrator`) iterates the journal — files
without journal entries are silently skipped. `npm run db:migrate`
reports "Migrations complete." regardless.

The dev database in this session was missing `users.locale` after a
container restart; the column only existed because a previous run had
applied the SQL directly via `psql`. After `db:migrate`, the column
was still missing.

**Attack scenario**
Not an attacker scenario — a self-inflicted production incident.
A new deploy provisions a fresh DB, runs `db:migrate`, gets the
journaled migrations (0028 being the latest journaled), and starts
serving. Any feature that depends on a non-journaled column fails
with a 500. For 0031 specifically, the password-reset flow throws
`column "locale" does not exist` on every request, blocking account
recovery.

If 0029 / 0030 / 0031 *have* been applied manually in production via
`psql`, that's worse: the production schema is now permanently out of
sync with what `db:generate` will produce on the next change, and
future migrations may fail with "column already exists" or similar.

**Why current implementation is vulnerable**
The `migrate.ts` runner contracts on the journal:

```ts
// lib/db/migrate.ts:14
await migrate(db, { migrationsFolder: "lib/db/migrations" });
```

`migrate()` reads `meta/_journal.json` and applies entries in order.
Files without entries are not surfaced.

**Remediation**
1. Run `drizzle-kit generate` against the current `lib/db/schema.ts`.
   It will diff vs the last journaled snapshot and produce both the
   SQL file AND the journal entry + snapshot.
2. For migrations already written by hand (0029-0031), the cleanest
   path is to regenerate them through drizzle-kit and verify the SQL
   matches. If the prod DB has them applied already, hand-edit
   `_journal.json` to append idx 29, 30, 31 entries pointing at the
   existing SQL files, AND record one INSERT into
   `drizzle.__drizzle_migrations` in prod so the runner sees them as
   "already applied":

```sql
-- One-off, run ONCE per environment that has the columns:
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES
  ('<sha256-of-0029-sql>', extract(epoch from now()) * 1000),
  ('<sha256-of-0030-sql>', extract(epoch from now()) * 1000),
  ('<sha256-of-0031-sql>', extract(epoch from now()) * 1000);
```

3. Wire a CI check: `npm run db:generate -- --dry-run` (or equivalent)
   that fails if `lib/db/migrations/*.sql` count ≠ journal entry count.

---

### F-02 — Sentry has no `beforeSend` scrubber

**Severity**: High
**Dimension**: INFRA · NEXT.JS
**Affected**: `sentry.server.config.ts`, `sentry.client.config.ts`
**OWASP**: A09-Security Logging and Monitoring Failures

**Vulnerability**
Both Sentry configs ship events to the dashboard without a
`beforeSend` hook. Sentry's default event includes request headers
(notably `Authorization`, `Cookie`, `X-CSRF-Token`), request body in
some integrations, and `extra` payload Sentry SDK helpers
automatically attach.

The application doesn't *currently* log credential bodies, but any
future careless `Sentry.captureException(err, { extra: { req } })` or
`console.error(req.body)` (which gets bridged to Sentry breadcrumbs)
silently exfiltrates passwords, session tokens, and 2FA codes to a
third-party SaaS.

**Attack scenario**
Insider with Sentry dashboard access (a small org rotates this freely
across contractors) can read recent password-reset POST bodies, login
attempts, 2FA verification codes — without ever touching the
application database. Or: a Sentry-side breach (Sentry has had
several over the years) exposes whatever was sent.

**Why current implementation is vulnerable**
No `beforeSend` filter, no `denyUrls`, no header allowlist. Sentry's
default behaviour is permissive.

**Remediation**
Add a strict `beforeSend` to both configs:

```ts
// sentry.server.config.ts
import * as Sentry from "@sentry/nextjs";

const SENSITIVE_HEADERS = new Set([
  "authorization", "cookie", "set-cookie",
  "x-csrf-token", "x-api-key", "proxy-authorization",
]);
const SENSITIVE_BODY_KEYS = new Set([
  "password", "newpassword", "oldpassword", "currentpassword",
  "token", "secret", "totp", "code", "csrftoken", "recoverycode",
]);

function scrubObject(obj: unknown, depth = 0): unknown {
  if (depth > 4 || obj == null) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => scrubObject(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = SENSITIVE_BODY_KEYS.has(k.toLowerCase())
      ? "[REDACTED]"
      : scrubObject(v, depth + 1);
  }
  return out;
}

Sentry.init({
  // ...existing config...
  beforeSend(event) {
    if (event.request?.headers) {
      for (const k of Object.keys(event.request.headers)) {
        if (SENSITIVE_HEADERS.has(k.toLowerCase())) {
          event.request.headers[k] = "[REDACTED]";
        }
      }
    }
    if (event.request?.data) {
      event.request.data = scrubObject(event.request.data);
    }
    if (event.extra) event.extra = scrubObject(event.extra) as typeof event.extra;
    if (event.contexts) event.contexts = scrubObject(event.contexts) as typeof event.contexts;
    return event;
  },
  beforeBreadcrumb(crumb) {
    if (crumb.category === "console" && crumb.data) {
      crumb.data = scrubObject(crumb.data) as typeof crumb.data;
    }
    return crumb;
  },
});
```

The same applies client-side; replicate in `sentry.client.config.ts`.

---

### F-03 — 2FA disable / regenerate routes are unrate-limited TOTP oracles

**Severity**: High
**Dimension**: AUTHN · API
**Affected**: `app/api/account/2fa/disable/route.ts:13-45`,
`app/api/account/2fa/regenerate/route.ts`,
`lib/repo/account-security.ts:disable2fa / regenerateRecoveryCodes`
**OWASP**: A07-Identification and Authentication Failures

**Vulnerability**
The login provider rate-limits TOTP verification via the
`auth.totp` bucket (`lib/auth.ts:306-322`). The `/api/account/2fa/
disable` and `/regenerate` routes verify TOTP through the same
`verifyTotp()` primitive but apply no rate limit at the route or
repo layer. A 6-digit TOTP has 1,000,000 combinations; without
throttling and with a ±1 window, an attacker can brute-force the
current TOTP code in seconds.

Both routes also require the user's current password — an attacker
with a stolen session typically does not have it. But the attack
matters when:

- The session is stolen on a managed device where the user "stay
  signed in" the browser AND the password was reused from a known
  breach (the attacker already has both).
- A malicious internal user has admin reset access to grant
  themselves a known temporary password (already mustChangePassword).

Once 2FA is disabled, every subsequent login from a new device skips
TOTP, and `auth.totp` rate limiting becomes moot.

**Why current implementation is vulnerable**
No `rateLimit("auth.totp.disable", userId, ...)` call inside the
disable / regenerate paths. `verifyTotp` returns false on miss but
the caller iterates freely.

**Remediation**
Mirror the login pattern at the route or repo layer:

```ts
// app/api/account/2fa/disable/route.ts (or push down to disable2fa)
import { rateLimit, rateLimitConsume } from "@/lib/ratelimit";

const TOTP_LIMIT = 5;
const TOTP_WINDOW_SEC = 60 * 15; // 15-minute lockout per user

export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;

  // Pre-flight peek — refuses to call bcrypt/verifyTotp if locked.
  const peek = await rateLimit("auth.totp.account_mut", r.ctx.userId, {
    limit: TOTP_LIMIT,
    windowSec: TOTP_WINDOW_SEC,
    commit: false,
  });
  if (!peek.ok) {
    return NextResponse.json(
      { error: "RATE_LIMITED" },
      { status: 429 },
    );
  }

  // ... existing parse / dispatch ...
  try {
    await disable2fa(r.ctx.userId, parsed.data.password, parsed.data.code);
    // success — don't consume the bucket
  } catch (err) {
    // Consume ONLY on credential failure so a legit user with a typo
    // doesn't lock themselves out fast.
    if ((err as Error).message === "INVALID_TOTP" ||
        (err as Error).message === "BAD_PASSWORD") {
      await rateLimitConsume("auth.totp.account_mut", r.ctx.userId, {
        limit: TOTP_LIMIT,
        windowSec: TOTP_WINDOW_SEC,
      });
    }
    // ... existing error mapping ...
  }
}
```

Apply the same to `/api/account/2fa/regenerate`. Consider also
adding it to `/api/account/2fa/enable` — pre-enrollment the secret
isn't yet committed so brute-force has no value, but a hostile
client can spam the route to thrash the DB.

---

## 4. Medium-severity findings

### F-04 — `/api/team/test-login` is an unrate-limited bcrypt oracle inside the owner's tenant

**Severity**: Medium
**Dimension**: AUTHN · API
**Affected**: `app/api/team/test-login/route.ts:27-91`
**OWASP**: A07-Identification and Authentication Failures

**Vulnerability**
The route lets an owner (or any user with `manage_team` permission)
submit an arbitrary email + password and learn one of: `user_not_
found`, `not_in_your_tenant`, `wrong_password`, `ok`. It is gated to
the caller's own tenant — owners cannot test passwords for other
tenants — but the bcrypt comparison runs on every call with **no
rate limit**.

Additionally, the distinction between `user_not_found` and
`not_in_your_tenant` leaks platform-wide email registration: any
owner can iterate a list of emails and learn which exist *anywhere*
on the platform (not just their own tenant).

**Attack scenario**
A. A compromised owner session (XSS-style takeover or a careless
   "stay signed in" on a shared laptop) becomes an unmetered
   bcrypt oracle against every staff member of that tenant. The
   attacker can brute-force staff passwords from leaked password
   lists at full CPU speed.
B. A malicious tenant owner can map out the platform's user base
   by iterating common emails: every "not_in_your_tenant" response
   confirms registration somewhere on the platform.

**Why current implementation is vulnerable**
No `rateLimit(...)` call. The repo helper does not throttle either.
The reason codes are distinct enums that leak more than a generic
"invalid" would.

**Remediation**
1. Apply a strict per-actor rate limit:

```ts
const TEST_LOGIN_LIMIT = 10;
const TEST_LOGIN_WINDOW_SEC = 60 * 60;

const rl = await rateLimit("team.test_login", r.ctx.userId, {
  limit: TEST_LOGIN_LIMIT,
  windowSec: TEST_LOGIN_WINDOW_SEC,
});
if (!rl.ok) {
  return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
}
```

2. Collapse `user_not_found` and `not_in_your_tenant` into a single
   response so platform-wide enumeration via this endpoint is
   neutralized:

```ts
if (!user || !user.passwordHash || !member || member.tenantId !== r.ctx.tenantId) {
  return NextResponse.json({
    ok: false,
    reason: "no_such_employee",
    message: "لا يوجد موظف بهذا البريد في متجرك",
  });
}
```

3. Log every call to `activity_logs` with category=`auth` so abuse
   is auditable.

---

### F-05 — `/api/uploads/team/[...path]` GET handler — verify path-traversal hardening end-to-end

**Severity**: Medium
**Dimension**: FILE · AUTHZ
**Affected**: `app/api/uploads/team/[...path]/route.ts` (file not
inspected in detail; called out by Explore agent)
**OWASP**: A01-Broken Access Control · A05-Security Misconfiguration

**Vulnerability**
The path segment is attacker-influenced via the `[...path]` dynamic
segment. The companion `lib/uploads.ts:99-112` `resolveTenantUpload`
guards write-side traversal correctly (`path.resolve` +
`startsWith` check against the tenant directory). The **read** side
must apply the identical guard before any `fs.readFile` call. Not
verified in this review.

There is also no IDOR check that the requesting user belongs to the
tenant whose directory is being read — paths like
`/api/uploads/team/<other-tenant-id>/<file>` must 403 even when
authenticated as a different tenant's user.

**Attack scenario**
If the read handler does `fs.readFile(path.join(BASE, ...pathSeg))`
without resolution + startsWith check, `/api/uploads/team/..%2F..%2F..%2Fetc%2Fpasswd`
escapes the tenant directory. If the handler doesn't check the
caller's tenant against the file's tenant, any logged-in user can
read any tenant's employee photos by guessing UUID paths.

**Remediation**
Confirm and lock down — pseudocode:

```ts
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { path: parts } = await params;

  // First segment MUST be the caller's tenant id (no leaking across).
  if (parts[0] !== r.ctx.tenantId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Path traversal guard — must mirror the write side.
  const resolved = resolveTenantUpload(r.ctx.tenantId, parts.slice(1));
  if (!resolved) {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }
  // ... fs.readFile(resolved) + correct content-type
}
```

Also add `Content-Disposition: inline; filename="..."` with a
sanitized filename, and set `X-Content-Type-Options: nosniff` (the
global header from middleware already does this, but confirm it
applies on `/api/uploads/*`).

---

### F-06 — `/api/products/import` CSV — no visible MIME / size enforcement

**Severity**: Medium
**Dimension**: FILE · API
**Affected**: `app/api/products/import/route.ts` (Explore agent
report)
**OWASP**: A05-Security Misconfiguration

**Vulnerability**
The route accepts a multipart upload with no Zod schema visible,
no documented size cap, and no MIME allowlist. A multi-megabyte
file forces the server to read it entirely into memory before
parsing. A craftily-truncated CSV with billions of cells can OOM
the worker.

CSV import also opens a **CSV injection** sink: if any imported
cell starts with `=`, `+`, `-`, `@`, downstream exports re-emitting
those cells into Excel or Google Sheets execute formulas. The
catalog flow probably re-emits product names verbatim into
receipts, the catalog, and analytics exports.

**Attack scenario**
Staff with import permission uploads a 2 GB CSV → OOM. Or uploads a
benign-looking sheet with a product named `=HYPERLINK("https://evil/x",
"see invoice")` → owner exports inventory → opens in Excel → formula
fires.

**Remediation**

```ts
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "text/csv",
  "application/vnd.ms-excel",
  "text/plain", // some browsers send this for .csv
]);

const file = formData.get("file");
if (!(file instanceof File)) {
  return NextResponse.json({ error: "FILE_REQUIRED" }, { status: 400 });
}
if (file.size > MAX_IMPORT_BYTES) {
  return NextResponse.json({ error: "FILE_TOO_LARGE" }, { status: 413 });
}
if (!ALLOWED_TYPES.has(file.type || "")) {
  return NextResponse.json({ error: "UNSUPPORTED_TYPE" }, { status: 415 });
}

// Sanitize formula-prefix cells on import to prevent CSV injection
// when re-exported. Defense in depth — exports should also escape.
function deformulize(cell: string): string {
  return /^[=+\-@]/.test(cell) ? `'${cell}` : cell;
}
```

Couple with a row count cap (e.g., 10k rows per import) and an
overall rate limit (1 import / minute / tenant).

---

### F-07 — `/api/account/password` (change) has no per-user rate limit

**Severity**: Medium
**Dimension**: AUTHN · API
**Affected**: `app/api/account/password/route.ts`
**OWASP**: A07-Identification and Authentication Failures

**Vulnerability**
The password-change route verifies `oldPassword` via bcrypt with no
throttle. A stolen session can brute-force the current password
(needed to defend changes triggered without re-auth).

**Attack scenario**
Attacker steals an `authjs.session-token` cookie via a hostile
browser extension. They have a valid session but the user's
password protects sensitive ops (change password, change recovery
codes, disable 2FA). The attacker calls `/api/account/password`
with the new password they want + a guessed `oldPassword`. With no
rate limit they can iterate top-N common passwords.

**Remediation**

```ts
const CHANGE_LIMIT = 5;
const CHANGE_WINDOW_SEC = 60 * 60;

const rl = await rateLimit("account.password_change", r.ctx.userId, {
  limit: CHANGE_LIMIT,
  windowSec: CHANGE_WINDOW_SEC,
});
if (!rl.ok) {
  return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
}
```

---

### F-08 — WhatsApp send endpoints — no per-tenant rate limit

**Severity**: Medium
**Dimension**: API · INFRA (cost / abuse)
**Affected**: `app/api/whatsapp/send/route.ts`,
`app/api/whatsapp/send-pdf/route.ts`,
`app/api/whatsapp/cloud/send/route.ts`,
`app/api/whatsapp/cloud/send-pdf/route.ts`,
`app/api/whatsapp/cloud/send-template/route.ts`,
`app/api/whatsapp/otp/send/route.ts`

**Vulnerability**
None of the WhatsApp outbound paths visibly invokes
`rateLimit(...)`. Each call charges the tenant's Meta send budget
and, for OTP, may carry SMS / WhatsApp Business pricing.

**Attack scenario**
A. A compromised staff session sends 10,000 messages to numbers
   the attacker controls before the tenant notices. Tenant pays.
B. A malicious staff member loops `/api/whatsapp/otp/send` to
   spam-grief a target phone number — the customer receiving the
   OTP storm has no recourse and the tenant's WhatsApp number
   ends up reported / blocked by Meta.

**Remediation**
Bucket per tenant + per recipient:

```ts
// per-tenant ceiling — protects budget.
const tenantRl = await rateLimit("wa.send.tenant", r.ctx.tenantId, {
  limit: 200,
  windowSec: 60,
});
// per-recipient ceiling — anti-spam-grief.
const recipientRl = await rateLimit("wa.send.recipient",
  `${r.ctx.tenantId}:${normalizedTo}`, {
    limit: 5,
    windowSec: 60,
  });
```

Specifically for OTP send: cap at 3 per phone per hour to match
common SMS norms.

---

### F-09 — `/api/whatsapp/webhook/events/[id]/replay` — privileged operation, no audit-distinct logging

**Severity**: Medium
**Dimension**: AUTHZ · API
**Affected**: `app/api/whatsapp/webhook/events/[id]/replay/route.ts`

**Vulnerability**
Replaying a webhook event can re-trigger any side-effect the event
caused: re-recording a payment indication, re-firing a customer
notification, double-creating a sale via webhook-driven automation
(if any). The route gates on `requireTenant()` but not on a
permission. Activity-log entries do not (per Explore agent) carry a
distinctive "replay" marker.

**Attack scenario**
Manager-level user replays an inbound webhook for a payment
notification → tenant's automation marks the same sale "paid" twice
or accidentally fires a duplicated WhatsApp confirmation to the
customer.

**Remediation**
1. Gate behind `requirePermission("admin")` or a new
   `"replay_webhooks"` permission.
2. In `logActivity`, set `action: "wa.webhook.replay"` and include
   the original event id + replay reason in the metadata.
3. Idempotency: refuse replay for events whose processing was
   recorded as `success` within the last N minutes unless an
   explicit `force=true` flag is set.

---

## 5. Low-severity / hardening

### F-10 — `CRON_SECRET` shared across all cron endpoints

**Severity**: Low
**Dimension**: AUTHN
**Affected**: `app/api/cron/**`

If the secret leaks (e.g., committed to a notes file, exposed in
shell history) the attacker can trigger account purge,
recurring-expense materialization, AND activity-log cleanup — all
three with one credential. Split into per-job secrets:
`CRON_SECRET_DELETION`, `CRON_SECRET_EXPENSES`,
`CRON_SECRET_ACTIVITY_CLEANUP`. The blast radius of one leak then
shrinks to one job.

### F-11 — `/api/notifications/stream` SSE — no per-tenant connection ceiling

**Severity**: Low
**Dimension**: API
**Affected**: `app/api/notifications/stream/route.ts`

A tenant with 200 staff each opening 3 tabs holds 600 long-lived
connections on this server. Node's `keep-alive` plus the
auto-close-after-5-min behaviour spreads load but a misbehaving
client can reconnect immediately and pin a slot. Cap connections
per `(tenantId, userId)` at 3-5, and per tenant at e.g. 200. Apply
backpressure with `keep-alive: 30; max=200` if the framework
exposes it.

### F-12 — `/api/billing/paymob/webhook` accepts HMAC in query string

**Severity**: Low
**Dimension**: AUTHN · INFRA
**Affected**: `app/api/billing/paymob/webhook/route.ts`

Per Paymob spec this is unavoidable, but the HMAC value now lands
in any access log along the path (nginx, CDN, app logs). Ensure
nginx's access log strips `?hmac=` (use `log_format` to omit query)
and that `console.log(req.url)` is never invoked in this route.

### F-13 — Geolocation captured per attendance check-in, retention unspecified

**Severity**: Low
**Dimension**: INFRA (PDPL / privacy)
**Affected**: `app/api/attendance/self/route.ts`,
`lib/db/schema.ts:attendanceEvents`

The schema retains `(lat, lng)` per event without an explicit purge
policy. Under PDPL, location data is special-category PII. Either:
- Truncate coordinates to 3 decimal places at storage time
  (~111 m precision — enough to verify geofence, not enough to
  retro-map an individual's home).
- Or purge raw lat/lng after the corresponding payroll period is
  finalized.

### F-14 — `/api/cron` prefix is publicly routable; route handlers MUST self-verify

**Severity**: Low
**Dimension**: AUTHN
**Affected**: `middleware.ts:124` (`PUBLIC_PREFIXES`)

`/api/cron` is in `PUBLIC_PREFIXES`. Existing handlers do their own
`Authorization: Bearer ${CRON_SECRET}` constant-time check, but the
contract is convention, not enforcement. A future cron route that
forgets the check would be publicly callable. Add a small wrapper:

```ts
// lib/api/require-cron.ts
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

export function requireCronSecret(req: Request, expected: string | undefined) {
  if (!expected) return NextResponse.json({ error: "DISABLED" }, { status: 503 });
  const got = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  return null; // ok
}
```

Then every cron route calls it as the first line.

### F-15 — Custom error class messages echoed verbatim to clients

**Severity**: Low
**Dimension**: API
**Affected**: various `app/api/**` routes that return
`err.message` from custom errors (e.g., `AttendanceStateError`,
`TeamConflictError`).

User-facing UX is good (specific Arabic / English messages), but
make sure no `err.message` path can carry DB column names or
internal IDs. Today this is clean per Explore review, but add a
lint rule or test to enforce "only custom-error messages, never
`err.message` from generic Error" in route handlers.

### F-16 — `app/[lang]/(auth)/actions.ts` returns full `parsed.error.issues[0].message` in some non-auth surfaces

**Severity**: Low
**Dimension**: API

The auth actions have been refactored to error codes (per the
auth-hardening work), but other action files (notably the
purchases/settings work currently uncommitted) may still return
raw Zod messages. Audit the same pattern across all server
actions.

### F-17 — Public catalog / receipts include shop-owner-customizable text

**Severity**: Low (preventive)
**Dimension**: INPUT (XSS)
**Affected**: `components/sales/Receipt.tsx`,
`components/sales/InvoiceReceipt.tsx`,
`components/settings/ReceiptDesigner.tsx`

Receipt footers and custom blocks are owner-typed text rendered
into React (escaped automatically). Today this is safe because
React escapes JSX text. The day someone introduces
`dangerouslySetInnerHTML` to support styled receipts is the day
this becomes stored XSS. Add a CI grep rule that fails any new use
of `dangerouslySetInnerHTML` outside an explicit allowlist
(`components/sales/Receipt.tsx` is NOT on it).

### F-18 — SVG logos stored as data URIs in `shop_settings`

**Severity**: Low
**Dimension**: INPUT (XSS via SVG)
**Affected**: `components/settings/ReceiptDesigner.tsx:204-235`

SVG can contain `<script>` and external references. Storage as a
data URI in JSON is safer than HTTP serving (no fetch on the
served-origin), but if the data URI is ever rendered into HTML via
`<img src={dataUri}>` it's safe; if it ever lands in
`dangerouslySetInnerHTML` or is served directly with
`Content-Type: image/svg+xml` it becomes script-execution. Sanitize
on upload using `DOMPurify` server-side, or convert SVG → PNG on
ingest.

### F-19 — Password reset error logging may carry DB error text

**Severity**: Low
**Dimension**: INFRA (logging)
**Affected**: `lib/repo/password-reset.ts:73,168` —
`console.warn("[pwreset] failed to store token:", err)` and
`console.error("[pwreset] failed to update password:", err)`

The raw error from `postgres` includes table/column names and
sometimes parameter values. Without a Sentry `beforeSend` filter
(F-02) this lands in Sentry intact. Wrap in
`err.message?.slice(0, 200)` or use the structured logger that
already exists for WhatsApp errors.

### F-20 — `users.must_change_password` flow allows admin to set a temp password — no enforced complexity

**Severity**: Low
**Dimension**: AUTHN
**Affected**: `app/api/team/[userId]/password/route.ts`

Owners create staff with passwords; the temp password complexity
is checked only against the `min(8)` Zod rule. A "Password1"
qualifies. Pair with a haveibeenpwned-style blocklist check (the
top-1000 common passwords) at minimum. The owner's intent is
"give my cashier a quick code" — fine — but the user is then
forced to change it on next login, so document that. Acceptable
as-is; flagged for posterity.

---

## 6. Hardening recommendations (no finding required)

The following are "should improve" items, not vulnerabilities.

1. **Content-Security-Policy still in `Report-Only` mode**
   (`middleware.ts:CSP_HEADER_NAME` defaults to Report-Only unless
   `CSP_ENFORCE=1`). Flip to enforcing in production. The
   `style-src 'unsafe-inline'` allowance for Tailwind 4 is the only
   carry-forward; document it as accepted risk and revisit when
   Tailwind 4 exposes a nonce hook.

2. **Subresource Integrity** — not in scope today (no external
   scripts shipped) but worth a pre-deploy check that no third-party
   `<script src=…>` slips into the build.

3. **`Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp`** — not present in
   `SECURITY_HEADERS`. COOP at minimum is cheap and defends against
   cross-origin tab-napping.

4. **Per-account session ceiling.** `tokenVersion` revokes all
   sessions, but nothing prevents a user from accumulating 50
   long-lived sessions. Cap at e.g. 10 active sessions per user and
   evict oldest on the 11th.

5. **NextAuth v5 is in beta (`5.0.0-beta.31`).** This is acknowledged
   in task.md as the "flaky custom-error-code propagation" pain. Keep
   an eye on the GA timeline; pin a tested patch version in
   `package-lock.json` and audit each upgrade.

6. **Rotate Paymob HMAC secret and `CRON_SECRET` quarterly** as a
   matter of policy. Document the runbook.

7. **WhatsApp access tokens** stored in `wa_connections` are sensitive
   credentials. Confirm at-rest encryption (the schema's `encrypted`
   suffix on the column name only narrows the gap if app-layer
   encryption is in place — verify; the existing audit comment says
   they're encrypted but I didn't open the column definition).

8. **`pg_trgm` / search columns** — multi-tenant search columns that
   bypass RLS (e.g., a `materialized view` for fast catalog search)
   would be a foot-gun. None observed today; mention in the
   architecture doc that all search must go through `withTenant`.

9. **Add a `Strict-Transport-Security` header at the nginx layer**
   (per task.md it's already there; verify after any nginx config
   change).

10. **No CAPTCHA on signup or forgot-password.** Acknowledged in
    `auth-flow-hardening.md` as a deliberate carry-forward; revisit
    if abuse appears.

---

## 7. Production-readiness score

**82 / 100.** Detailed by dimension:

| Dimension | Score | Why |
| --- | --- | --- |
| Authentication | 88 | TOTP brute-force on disable (F-03) and rate-limit gaps (F-04, F-07) cost points. |
| Authorization | 92 | RLS + permission helpers consistent; replay-webhook gap (F-09) is the one outlier. |
| Database | 88 | Strong RLS posture; migration journal drift (F-01) is the only blocker. |
| Input validation | 90 | Zod-everywhere; CSV import (F-06) is the gap. |
| API hygiene | 78 | Several mutation routes need rate limits (F-07, F-08); one credential oracle (F-04). |
| File security | 80 | Write side is hardened; read side (F-05) and CSV (F-06) need confirmation. |
| Browser security | 88 | CSP + nonce + per-request headers; flip CSP to enforce + add COOP. |
| Infrastructure | 70 | Sentry scrubber missing (F-02), shared cron secret (F-10), geo retention undocumented (F-13). |
| Next.js specifics | 92 | Server Actions properly gate, no client/server boundary leaks observed. |
| Dependencies | 78 | Next.js beta + NextAuth v5 beta carry inherent risk; pin and watch. |

Weighted mean rounded.

---

## 8. OWASP Top 10 (2021) coverage

| Risk | Coverage | Notes |
| --- | --- | --- |
| A01-Broken Access Control | **Strong** | RLS + permission helpers; only F-05 (uploads read path) is unverified. |
| A02-Cryptographic Failures | **Strong** | bcrypt(12) for passwords, SHA-256 for reset tokens, AES (assumed) for WA tokens, TLS at the edge. |
| A03-Injection | **Strong** | Drizzle parameterized everywhere; no `sql.raw` interpolating user input; React JSX escapes. CSV injection (F-06) is the residual. |
| A04-Insecure Design | **Acceptable** | Auth design solid (TOTP + recovery codes + tokenVersion). F-04 / F-09 are design-level gaps. |
| A05-Security Misconfiguration | **Weak** | F-01 (migration drift), F-02 (Sentry), F-10 (shared cron secret), F-14 (cron prefix discipline). |
| A06-Vulnerable Components | **Acceptable** | NextAuth v5 beta + Next 16 + Drizzle latest; no known CVEs in `package.json` deps as of the audit. `npm audit` should be a CI step. |
| A07-Identification & Authentication | **Acceptable** | Strong baseline; F-03, F-04, F-07 are the gaps. |
| A08-Software & Data Integrity | **Strong** | Webhook HMAC verification on both Meta and Paymob. CSP report-only is the gap. |
| A09-Logging & Monitoring | **Weak** | Sentry scrubber gap (F-02) + raw error logging in pwreset (F-19). Activity log itself is comprehensive. |
| A10-SSRF | **Strong** | No outbound HTTP based on user-supplied URLs observed. WhatsApp + Paymob endpoints are app-controlled. |

---

## 9. Multi-tenant security assessment

**Verdict: strong.** This is the application's strongest dimension.

- **Postgres FORCE ROW LEVEL SECURITY** on all 33 tenant-scoped
  tables (verified via Explore agent + cross-reference against
  `lib/db/migrations/0004*.sql` and subsequent RLS migrations).
- **`app.tenant_id` set per transaction** inside `withTenant`
  (`lib/db/index.ts:45-52`), using `set_config(..., true)` (the
  `true` = local scope, automatically cleared at TX end — correct
  for connection pools).
- **No bypass paths** other than admin-context reads on global
  tables (`tenants`, `tenant_members`, `tenantDeletions`). Each
  documented and intentional.
- **No mass-assignment** observed: every `.values()` enumerates
  columns.
- **Cross-tenant credential oracle (F-04)** is the only multi-tenant
  *leak*, and only to the platform email-existence space — does
  not yield data.

**Recommendations**
1. Add an automated integration test that runs:
   ```
   set_config('app.tenant_id', '00000000-...-A', true);
   SELECT * FROM sales;  -- must return only tenant A's rows
   set_config('app.tenant_id', '00000000-...-B', true);
   SELECT * FROM sales;  -- must return only tenant B's rows
   ```
   on every CI run. The H01 restore-drill smoke covered this once;
   make it permanent.

2. Document that any new tenant-scoped table requires:
   a. A migration with `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;
       ALTER TABLE ... FORCE ROW LEVEL SECURITY;`
   b. A policy using `NULLIF(current_setting('app.tenant_id', true), '')::uuid`.
   c. A repo function that wraps reads/writes in `withTenant`.
   The `0004_*` migration is the canonical example.

---

## 10. Authentication & session security assessment

**Verdict: strong with three patchable gaps (F-03, F-04, F-07).**

**Strengths**
- bcrypt cost 12 for passwords.
- TOTP RFC 6238 with ±1 window; recovery codes generated, hashed,
  consumed atomically.
- `tokenVersion` channel allows "sign out everywhere" + atomic
  invalidation on password change / 2FA toggle / explicit revoke.
- JWT cookies set `HttpOnly + Secure + SameSite=Lax`.
- Login uses NextAuth credentials provider with constant-time email
  comparison (via normalized input), bcrypt verify, rate-limit
  buckets per IP and per email.
- Open-redirect closure via `safeNext` (recently shipped).
- Password reset via 30-min Redis token, hashed at rest, single-use
  consumption that increments `tokenVersion` (atomic invalidation
  of every other session).
- Locale-aware reset email (recently shipped) means recovery in the
  user's native language.

**Gaps (mapped to findings)**
- **F-03**: 2FA disable / regenerate are unrate-limited TOTP
  oracles. Patch first.
- **F-04**: `test-login` is an unrate-limited bcrypt oracle within
  the owner's tenant.
- **F-07**: `/api/account/password` is unrate-limited.
- **F-02**: Sentry scrubber gap could leak password / TOTP from
  any future careless `console.error(req.body)`.
- **Beta dependency**: NextAuth v5 beta. Behavioural changes
  between betas have already cost development time (see auth
  hardening commits and the `2fa-needed` precheck workaround).

**Session ceiling.** The system has no per-user active-session cap.
A user with 50 stale sessions (e.g., from forgotten phones) keeps
each in scope until expiry. Combined with `tokenVersion`, this is
safe (any password change invalidates them all), but cleaning up
stale sessions on a schedule would be hygiene.

**Hardening priorities (engineering)**
1. F-01 first (production correctness blocker).
2. F-02 second (one-time config change, prevents future leaks).
3. F-03 third (closes the most-real auth bypass path).
4. F-04, F-07 in the same batch (consistent rate-limit pattern).
5. F-05, F-06 once you can read the actual routes.

---

## Appendix A — Findings index

| ID | Title | Sev |
| --- | --- | --- |
| F-01 | Migration journal drift (0029-0031) | High |
| F-02 | Sentry missing `beforeSend` scrubber | High |
| F-03 | 2FA disable/regenerate TOTP brute-force | High |
| F-04 | `/api/team/test-login` credential oracle | Medium |
| F-05 | `/api/uploads/team/[...path]` read-side traversal/IDOR (verify) | Medium |
| F-06 | `/api/products/import` CSV size + injection | Medium |
| F-07 | `/api/account/password` no rate limit | Medium |
| F-08 | WhatsApp send endpoints no rate limit | Medium |
| F-09 | Webhook replay needs permission + idempotency | Medium |
| F-10 | `CRON_SECRET` shared | Low |
| F-11 | SSE notification stream no connection cap | Low |
| F-12 | Paymob HMAC in query string — log scrub | Low |
| F-13 | Attendance geo data retention undocumented | Low |
| F-14 | `/api/cron` prefix discipline as middleware wrapper | Low |
| F-15 | Custom error messages — lint rule | Low |
| F-16 | Non-auth actions may still return Zod messages | Low |
| F-17 | `dangerouslySetInnerHTML` allowlist (preventive) | Low |
| F-18 | SVG logo sanitization | Low |
| F-19 | Password-reset error logging text | Low |
| F-20 | Temp password complexity | Low |

End of report.
