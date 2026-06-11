# Platform Admin — Spec 01: Foundation

Owner: Amr · Drafted: 2026-06-10 · Depends on: nothing.

The migration that creates every admin table, the login + forced
rotation flow, and the bare minimum `AdminShell` so subsequent specs
have a UI to mount into. After this spec ships, the only thing an admin
can actually do is log in, rotate their password, and view a placeholder
dashboard.

Read the [master spec][master] §2 (security model) first — every rule
there applies here. This spec doesn't restate them.

[master]: ./platform-admin-dashboard.md

---

## 1. Goal

A platform admin can:

1. POST to `/admin/login` with `admin@matgary.com / 12345678` and
   receive a session cookie.
2. Be redirected to `/admin/account/password?required=1` because of
   `must_rotate=true`.
3. Set a new password matching the rules in [master §2.4][master].
4. Land on `/admin` (placeholder, "Welcome, Amr").
5. Update their display name + email on `/admin/account`.
6. Sign out (single session) or "sign out everywhere" (all sessions).

A non-admin gets 404 on any `/admin/*` path.

---

## 2. Data — migration `0034_platform_admin.sql`

This **one** migration creates every table the whole admin initiative
ever needs, plus the column additions on `tenants`. Later sub-specs do
NOT add migrations; they just use these tables.

### 2.1 New tables

```sql
CREATE TABLE IF NOT EXISTS admins (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               citext NOT NULL UNIQUE,
  password_hash       text NOT NULL,
  display_name        text,
  role                text NOT NULL DEFAULT 'ops_admin'
                       CHECK (role IN ('super_admin', 'ops_admin')),
  must_rotate         boolean NOT NULL DEFAULT false,
  -- 2FA columns reserved for v1.1; null = disabled in v1.
  totp_secret         text,
  totp_enabled_at     timestamptz,
  last_login_at       timestamptz,
  last_login_ip       text,
  failed_attempts     int NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  disabled_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by_admin_id uuid REFERENCES admins(id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id        uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  session_token   text NOT NULL UNIQUE,
  ip              text,
  user_agent      text,
  -- Reserved for Spec 07 (impersonation). NULL means normal admin browsing.
  impersonating_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  impersonating_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id);
CREATE INDEX admin_sessions_token_idx ON admin_sessions (session_token);

CREATE TABLE IF NOT EXISTS admin_password_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_pw_history_admin_idx
  ON admin_password_history (admin_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id        uuid NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
  action          text NOT NULL,
  target_kind     text,
  target_id       uuid,
  ip              text,
  user_agent      text,
  before_jsonb    jsonb,
  after_jsonb     jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_admin_time_idx
  ON admin_audit_log (admin_id, occurred_at DESC);
CREATE INDEX admin_audit_target_idx
  ON admin_audit_log (target_kind, target_id);

-- For Spec 04. Created now so the schema only changes once.
CREATE TABLE IF NOT EXISTS platform_plans (
  key            text PRIMARY KEY,
  label_ar       text NOT NULL,
  label_en       text NOT NULL,
  tagline_ar     text NOT NULL,
  tagline_en     text NOT NULL,
  monthly_egp    int  NOT NULL DEFAULT 0,
  purchasable    boolean NOT NULL DEFAULT false,
  features_ar    text[] NOT NULL DEFAULT '{}',
  features_en    text[] NOT NULL DEFAULT '{}',
  sort_order     int NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by_admin_id uuid REFERENCES admins(id) ON DELETE SET NULL
);

-- For Spec 06. Created now so the schema only changes once.
CREATE TABLE IF NOT EXISTS platform_broadcasts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_ar        text NOT NULL,
  title_en        text NOT NULL,
  body_ar         text,
  body_en         text,
  severity        text NOT NULL DEFAULT 'info'
                   CHECK (severity IN ('info', 'warning', 'critical')),
  audience        text NOT NULL DEFAULT 'all'
                   CHECK (audience IN ('all', 'owners', 'staff')),
  starts_at       timestamptz NOT NULL DEFAULT now(),
  ends_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by_admin_id uuid REFERENCES admins(id) ON DELETE SET NULL
);
```

### 2.2 New columns on existing tables

```sql
-- For Spec 03 (suspend). NULL = active.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_reason text;
CREATE INDEX IF NOT EXISTS tenants_suspended_idx
  ON tenants (suspended_at) WHERE suspended_at IS NOT NULL;
```

### 2.3 Bootstrap admin

The SQL file ships **no real password hash**. `lib/db/migrate.ts` is
extended to, on every run:

1. Read `BOOTSTRAP_ADMIN_EMAIL` (default `admin@matgary.com`).
2. Read the hard-coded plaintext seed (`12345678`) and bcrypt it at
   cost 12 in-process.
3. INSERT … ON CONFLICT (email) DO NOTHING.

So the SQL file never sees a credential and re-runs are idempotent.

### 2.4 Seed `platform_plans` from `lib/payments/plans.ts`

The migrate script also seeds the three plan rows from the typed
`PLANS` object today, so `/billing` and the landing page keep rendering
between Spec 01 and Spec 04. Specs 04 swaps the runtime read path to
the DB row.

### 2.5 Drizzle types

`lib/db/schema.ts` gets the six new tables added. Note in a comment:
admin tables are intentionally read **only** via `lib/admin/db.ts`
(the BYPASSRLS pool). They're typed here for completeness.

---

## 3. New DB role

Migrate script also runs (idempotent):

```sql
DO $$ BEGIN
  CREATE ROLE matgary_admin LOGIN PASSWORD '<from env>';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER ROLE matgary_admin BYPASSRLS;
GRANT CONNECT ON DATABASE matgary TO matgary_admin;
GRANT USAGE ON SCHEMA public TO matgary_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO matgary_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO matgary_admin;
```

`.env` adds `ADMIN_DATABASE_URL=postgres://matgary_admin:<pw>@…`.

---

## 4. New code modules

```
lib/admin/db.ts                  — drizzle pool over ADMIN_DATABASE_URL
lib/admin/auth.ts                — bcrypt + session token gen + password rules
lib/admin/session.ts             — cookie helpers (read/write/destroy)
lib/admin/audit.ts               — logAuditEvent(adminId, action, …)
lib/admin/permissions.ts         — role enum + requireSuperAdmin / requireAdmin
lib/admin/rate-limit.ts          — Redis-backed login rate limiter
```

Plus the public-facing module that all routes will use:

```
lib/admin/middleware.ts          — IP allowlist + cookie validate + role guard
```

`lib/db/migrate.ts` is extended with the bootstrap-admin seed step.

---

## 5. API surface

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/admin/auth/login` | body `{ email, password }`. IP+global rate-limited. Returns 404 outside IP allowlist. |
| `POST` | `/api/admin/auth/logout` | revokes current session. |
| `POST` | `/api/admin/auth/sign-out-everywhere` | deletes all admin_sessions for the caller. |
| `POST` | `/api/admin/auth/rotate-password` | body `{ currentPassword, newPassword }`. Forced when `must_rotate=true`. |
| `GET`  | `/api/admin/account` | own profile. |
| `PATCH`| `/api/admin/account` | partial: email, displayName. Email change re-confirmed via current password. |

Every POST/PATCH writes an `admin_audit_log` row.

---

## 6. UI surfaces

### 6.1 `/admin/login`

Minimal centered card: email + password + submit. No "remember me",
no "forgot password" link. Errors are intentionally vague ("Incorrect
email or password") — same response for "no such email" vs "wrong
password" so an attacker can't enumerate.

### 6.2 `/admin/account` + `/admin/account/password`

The Password page is presented in two modes:
- **Required** (`?required=1`): no cancel button, no nav links. Sole way
  out is to set a new password.
- **Optional**: standard form with cancel.

### 6.3 `/admin` (placeholder for this spec)

Single welcome card: "Welcome, {displayName}." Mostly here so the
post-rotation redirect lands somewhere. Spec 02 replaces it with the
real overview.

### 6.4 `AdminShell` (component)

Sidebar: Account · Sign out. (More entries appear in later specs.)
Topbar: admin's email + role badge + "Sign out everywhere" link.

---

## 7. Cron

`POST /api/cron/admin-session-cleanup` — daily 03:30 UTC, same
`CRON_SECRET` pattern as `/api/cron/recurring-expenses`:

- Delete `admin_sessions` past `expires_at`.
- Detect bootstrap admin still on default + 7 days old → log warning.
- Detect any admin with `failed_attempts > 10` and not locked → lock
  for 1 hour.

---

## 8. Edge cases

| Scenario | Behavior |
| --- | --- |
| Login with valid creds but `disabled_at IS NOT NULL` | 401, same generic message. No leak. |
| Login during `locked_until > now()` | 429 with `Retry-After`. |
| Password rotation fails reuse check | 400 `PASSWORD_REUSED` — last-3 history. |
| `ADMIN_DATABASE_URL` unset on boot | Server boots; `/admin/*` returns 503 with admin-only error page. Tenant routes unaffected. |
| Bootstrap admin still on `12345678` after 7 days in production | `process.exit(1)` on next boot with loud log line. |
| `must_rotate=true` admin tries to GET `/admin/anything` | middleware 302 → `/admin/account/password?required=1`. |
| Migration re-applied | `ON CONFLICT DO NOTHING` on the admin insert. |
| Tenant route imports `@/lib/admin/db` | ESLint `no-restricted-imports` fails CI. |

---

## 9. Test plan

### Unit
- Password validator: every rule in [master §2.4][master].
- Session token: 32 byte base64; verify no collisions across 1M draws.
- Rate-limit window correctness.

### Integration
- Login happy path → cookie set → /admin GET 200.
- Wrong password 3× in 15 min → 4th attempt → 429.
- Anonymous GET on `/admin` and `/api/admin/anything` → **404**.
- Bootstrap admin → forced rotate → second login works with new pw.
- Rotating to a previous password → 400 `PASSWORD_REUSED`.

### Security smoke
- `Set-Cookie: __matgary_admin_session=…; HttpOnly; Secure;
  SameSite=Strict; Path=/admin`.
- `ADMIN_IP_ALLOWLIST=10.0.0.0/8` → request from 1.1.1.1 returns 404
  for `/admin` and `/admin/login`.
- `matgary_app` DB role cannot `SELECT * FROM admins`.

---

## 10. Acceptance criteria

- [ ] `npm run db:migrate` applies 0034 cleanly, seeds bootstrap admin,
      seeds 3 plan rows, creates `matgary_admin` role.
- [ ] `POST /api/admin/auth/login` returns 200 + cookie with the
      defaults; second POST without rotation returns 302 to the
      password page.
- [ ] After rotation, GET `/admin` renders the placeholder welcome
      card.
- [ ] `/admin/account` PATCH updates display name + audits the change.
- [ ] Anonymous GET `/admin` → 404 (verified in browser + curl).
- [ ] ESLint CI fails when a tenant route tries to import
      `@/lib/admin/db`.

---

## 11. Files this spec produces

```
lib/db/migrations/0034_platform_admin.sql
lib/db/schema.ts                              (additions)
lib/db/migrate.ts                              (bootstrap seed step)
lib/admin/db.ts
lib/admin/auth.ts
lib/admin/session.ts
lib/admin/audit.ts
lib/admin/permissions.ts
lib/admin/rate-limit.ts
lib/admin/middleware.ts
app/admin/login/page.tsx
app/admin/page.tsx                             (placeholder)
app/admin/account/page.tsx
app/admin/account/password/page.tsx
app/api/admin/auth/login/route.ts
app/api/admin/auth/logout/route.ts
app/api/admin/auth/sign-out-everywhere/route.ts
app/api/admin/auth/rotate-password/route.ts
app/api/admin/account/route.ts
app/api/cron/admin-session-cleanup/route.ts
components/admin/AdminShell.tsx
proxy.ts                                       (or middleware.ts addition)
.eslintrc.json                                 (no-restricted-imports rule)
.env.example                                   (ADMIN_* env vars)
dictionaries/ar.json + en.json                 (app.admin.login.*, app.admin.account.*)
```
