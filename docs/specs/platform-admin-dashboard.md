# Platform Admin Dashboard — Master / Index

Owner: Amr · Drafted: 2026-06-10 · Last revision: 2026-06-10 (split into sub-specs)

A separate, godmode area at `/admin/*` for the Matgary platform owner
(us) to monitor, support, and operate every tenant on the platform. NOT
a tenant-side feature. Lives behind its own login, its own DB role, its
own session cookie, and its own audit trail.

This **index** carries the shared security model + data foundation that
every sub-spec relies on. Each sub-spec stays narrowly focused on its
own slice and just references this doc for the basics.

---

## 1. Goal

A signed-in platform admin should be able to:

1. **See the whole platform at a glance** — how many tenants exist,
   how many are paying vs trialing, MRR, daily signups, churn signals.
2. **Drill into one tenant** to support / debug them — owner contact,
   subscription state, branches, employee count, last login, last sale,
   recent activity.
3. **Edit landing-page plan content** without redeploying.
4. **Add / remove admins**, change own credentials, rotate the
   bootstrap default on first login.
5. **Act on a tenant** — suspend, extend a trial, impersonate the owner
   for support (loud banner + audit row).

**Top-level acceptance:**

- Bootstrap super-admin `admin@matgary.com / 12345678` is forced to
  rotate password on first login. Never accepts the default beyond
  the first action.
- A non-admin user landing on `/admin/*` gets a hard 404, NOT a 403.
- Every admin write action lands in `admin_audit_log` with actor + IP
  + user-agent + before/after diff.
- Impersonation produces a tenant-visible "you are being impersonated
  by X" banner that the tenant owner can't dismiss.
- The two existing tenant features (cash reconciliation, daily digest)
  keep working unchanged. No tenant code reads admin tables.

---

## 2. Security model (shared)

Re-read this section every time we touch admin code.

### 2.1 Separate auth surface

- Login at `/admin/login`. Different page, different form, different
  session cookie name: `__matgary_admin_session`.
- Cookie attributes: `HttpOnly`, `Secure`, `SameSite=Strict`,
  fixed-domain.
- Server-side session record in `admin_sessions` so we can revoke
  individually — never a stateless JWT.
- Idle TTL **2 hours**. Absolute TTL **8 hours**. No "remember me".
- Rate limit `/admin/login`: **3 failures per 15 min per IP** plus
  **30 failures per 5 min globally**. On lockout: 429 with
  `Retry-After`.
- Optional IP allowlist via `ADMIN_IP_ALLOWLIST` env (comma-separated
  CIDRs). When set, `/admin/*` returns **404** (not 403) for any other
  IP — the URL space stays invisible.

### 2.2 Separate DB role

- DB role `app_admin` is granted `BYPASSRLS`. Admin queries see every
  tenant in one query.
- Tenant routes keep using `matgary_app` (no BYPASSRLS).
- Admin Next.js routes acquire a pool that connects as `app_admin`.

```ts
// lib/admin/db.ts — separate module from lib/db
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
export const adminDb = drizzle(postgres(process.env.ADMIN_DATABASE_URL!));
```

```env
ADMIN_DATABASE_URL=postgres://matgary_admin:<pw>@localhost:5434/matgary
ADMIN_SESSION_SECRET=<32 bytes>
ADMIN_IP_ALLOWLIST=        # empty = open; comma-separated CIDRs to restrict
ADMIN_IP_ALLOWLIST_BYPASS_USER=  # one email that bypasses the allowlist (lockout escape hatch)
BOOTSTRAP_ADMIN_EMAIL=     # defaults to admin@matgary.com
```

**ESLint rule** added in Spec 01: `no-restricted-imports` for
`^@/lib/admin` from any file outside `app/admin` + `app/api/admin`. CI
gate so a tenant route can never accidentally bypass RLS.

### 2.3 Bootstrap admin

- Migration 0034 seeds one row: email = `BOOTSTRAP_ADMIN_EMAIL` (default
  `admin@matgary.com`), password = `12345678` bcrypt'd at migration
  runtime, `must_rotate=true`.
- The SQL file never contains the real hash. The migration runner
  generates it at apply time so a leaked repo doesn't = admin creds.
- Boot-time check: if any admin still has `must_rotate=true` AND
  `created_at < now() - 7 days`, the server logs a loud warning and
  **refuses to start in production**. Dev unaffected.

### 2.4 Password rules

| Rule | Value |
| --- | --- |
| Minimum length | 12 chars |
| Required classes | ≥1 lowercase, ≥1 uppercase, ≥1 digit |
| Hash | bcrypt cost 12 |
| Reuse | Cannot match the last 3 hashes (`admin_password_history`) |
| Rotation | Forced every 90 days. Banner 7 d before; hard block at 90. |
| Breach check (HIBP) | v1.1 |
| 2FA | v1.1 (schema slots reserved) |

### 2.5 Hard 404 vs 403

`/admin/*` returns 404 to any request that:

- isn't from an allowed IP (when `ADMIN_IP_ALLOWLIST` is set), OR
- doesn't carry a valid admin session cookie.

Same response as a random nonexistent path. Anybody scanning sees
nothing.

### 2.6 Audit log

Every admin **write** lands in `admin_audit_log`:

```sql
admin_audit_log (
  id, admin_id, action, target_kind, target_id,
  ip, user_agent, before_jsonb, after_jsonb, occurred_at
)
```

Reads are not logged (table would explode). Impersonation start / exit
are logged as their own actions.

### 2.7 Roles

Two roles in v1:

| Role | Powers |
| --- | --- |
| `super_admin` | Everything: manage admins, edit plans, impersonate owners, suspend tenants. |
| `ops_admin` | Read-only on tenants + audit. Can extend a trial. Cannot manage admins, edit plans, or impersonate. |

Finer permissions are out of scope.

---

## 3. Data foundation (shared)

The migration in **Spec 01** lays down every table this initiative
ever needs. Later specs only **use** these tables — no new migrations
unless a spec explicitly says so.

Tables created in 0034:

- `admins` — accounts, role, must_rotate, locked_until.
- `admin_sessions` — server-side sessions + impersonation context.
- `admin_password_history` — last-3 reuse check.
- `admin_audit_log` — every write.
- `platform_plans` — DB-backed pricing for the landing page.
- `platform_broadcasts` — system-wide announcements.

Columns added to existing tables in 0034:

- `tenants.suspended_at timestamptz NULL`
- `tenants.suspended_reason text NULL`

Schema details live in **Spec 01 §4**.

---

## 4. Rollout — sequential sub-specs

Each item below links to its own spec doc. They must be built in this
order: every later spec assumes the earlier ones are in production.

| # | Sub-spec | Status | Key delivery |
| - | --- | --- | --- |
| 01 | [Foundation — auth + login + forced rotation](./platform-admin-01-foundation.md) | pending | `admin@matgary.com` can log in, rotates default, lands on placeholder `/admin`. |
| 02 | [Tenants overview + list + detail (read-only)](./platform-admin-02-tenants-read.md) | pending | KPI dashboard + searchable tenant list + drill-down detail page. |
| 03 | [Tenant write actions: suspend / unsuspend / extend trial](./platform-admin-03-tenants-write.md) | pending | Suspend pauses tenant immediately. Extend trial bumps `trialEndsAt`. All audited. |
| 04 | [Platform plan editor + landing-page wiring](./platform-admin-04-plans-editor.md) | pending | Edit Professional price/features without a deploy. |
| 05 | [Admins management](./platform-admin-05-admins-mgmt.md) | pending | Add ops/super admins. Promote / demote / disable. Last-super-admin guard. |
| 06 | [Broadcasts](./platform-admin-06-broadcasts.md) | pending | System-wide banner shown across every tenant's UI. |
| 07 | [Impersonation](./platform-admin-07-impersonation.md) | pending | Highest-risk. Loud tenant-side red banner + full audit trail. |
| 08 | [Audit log UI](./platform-admin-08-audit-log.md) | pending | Searchable viewer over `admin_audit_log` with diff modal. |

Build only the spec you've green-lit. Don't get ahead of the spec.

---

## 5. Open questions (settle before Spec 01)

1. **2FA in v1 or v1.1?** Schema is reserved either way. ~half a day if
   we want it in v1. Recommend v1 if any external person will get an
   admin account before public beta.
2. **`ADMIN_IP_ALLOWLIST` default — open or closed in production?**
   Recommend open with a one-line install hint to close it once stable.
3. **Impersonation length — 30 min hard cap, or auto-extend on
   activity?** Recommend hard cap so it can't drift into a multi-hour
   shadow session.
4. **`BOOTSTRAP_ADMIN_EMAIL` env override** — default to
   `admin@matgary.com`, but accept any value. OK?
5. **Tenant-side visibility of impersonation history** — when an admin
   impersonated the owner, surface that in the owner's own activity
   log? Recommend yes (trust-building).
6. **Bootstrap admin auto-disable** — if the default `12345678`
   password isn't rotated within 7 days, should the admin be
   auto-disabled (forces re-bootstrap) or just refuse server boot?
   Recommend "refuse server boot in production" (current spec) because
   auto-disable creates a chicken-and-egg lockout.

---

## 6. Out of scope (entire initiative, v1)

- 2FA (schema reserved; v1.1 candidate).
- Per-tenant feature flags.
- Email password reset (no transactional email pipeline yet).
- Tenant CSV export from the UI (psql one-off works for v1).
- Stripe migration (Paymob stays).
- Auditable **read**-log.
- Multi-region / multi-currency admin tooling.
