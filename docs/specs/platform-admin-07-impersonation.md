# Platform Admin — Spec 07: Impersonation

Owner: Amr · Drafted: 2026-06-10 · Depends on: **Specs 01, 02, 03**.

The highest-risk slice of the entire initiative. A `super_admin` can
"log in as" a tenant owner for support work. Every safeguard in this
spec exists because the action gives one person bypass-RLS reach into
a customer's data.

Build this last. Earlier specs deliberately gate it: until impersonation
is needed, support requests are handled by reading data via Specs 02
and 03.

[master]: ./platform-admin-dashboard.md

---

## 1. Goal

- `super_admin` opens tenant detail → **Impersonate owner** → confirms
  the legal-weight modal → lands in the tenant's app as the owner.
- Tenant app renders a **persistent red banner** the owner cannot
  dismiss: "أنت تتصفح المتجر باسم {owner.name} بواسطة الإدارة
  ({admin.email})" / "You are viewing this store as {owner.name} via
  platform support ({admin.email}). Click here to exit."
- Every write during the impersonation tags `actor.impersonatedBy =
  adminId` in `activity_log.metadata`.
- 30-minute hard cap on the impersonation session.
- Admin can exit anytime via the banner button — drops the tenant
  session, keeps the admin session.
- The owner's own activity feed surfaces these sessions as
  `system.impersonation` rows (per the open question in master §5;
  Spec 07 implements the "yes, surface it" answer).

---

## 2. Data — no new migrations

`admin_sessions.impersonating_tenant_id` and
`.impersonating_user_id` already exist from Spec 01. No additions.

We do extend `activity_log.metadata` (existing jsonb column) at the
**write side** to include:

```jsonc
{
  "impersonatedBy": "<adminId>",
  "impersonationAdminEmail": "<admin.email>"
}
```

No schema change needed (jsonb accepts new keys).

---

## 3. Session model

This is the trickiest part. Two parallel cookies coexist during
impersonation:

| Cookie | Domain / path | TTL | Carries |
| --- | --- | --- | --- |
| `__matgary_admin_session` | Path=/admin | 8 h absolute | Admin identity. Untouched by impersonation. |
| `next-auth.session-token` (tenant) | Path=/ | 30 min HARD CAP for impersonation | Tenant identity = the owner being impersonated. Carries `impersonation: { adminId, adminEmail, startedAt, sessionId }` flag. |

When impersonation starts:

1. Read tenant owner: `tenant_members` where `role='owner'` AND
   `tenants.id = :tenantId` — pick the first row. If multiple owners,
   pick the one with most-recent `users.last_seen_at`.
2. Refuse if owner's account is disabled.
3. Refuse if tenant is suspended (Spec 03) — admin must unsuspend
   first.
4. Create a tenant session row for that owner via NextAuth (DB
   sessions, already used in the app). Set the session's `expires_at`
   to `now() + 30 min` regardless of normal session TTL.
5. Stamp the tenant session with `impersonation_admin_id` + payload.
6. Write an `admin_audit_log` row: `action='impersonate.start'`,
   `target_kind='tenant'`, `target_id=tenantId`, before = `null`,
   after = `{ ownerId, sessionId, ttlSec: 1800 }`.
7. Redirect to `/`.

When impersonation exits:

1. Delete the tenant session row (revokes it on every device).
2. Write audit: `action='impersonate.end'`.
3. Redirect to `/admin/tenants/[id]` — the admin cookie was never
   touched, so they're still signed in.

---

## 4. Session callback wiring

`auth.ts` already has a session callback. Extend it:

```ts
// auth.ts (sketch)
async session({ session, token, user }) {
  const row = await db.select().from(sessions).where(eq(sessions.id, token.sessionId));
  if (row.impersonation_admin_id) {
    session.impersonation = {
      adminId: row.impersonation_admin_id,
      adminEmail: row.impersonation_admin_email,
      startedAt: row.impersonation_started_at,
    };
  }
  return session;
}
```

Plus a new column on the existing `sessions` table:

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS impersonation_admin_id uuid;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS impersonation_admin_email text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS impersonation_started_at timestamptz;
```

This is the **only** new column added past Spec 01's migration —
unavoidable because the NextAuth `sessions` table is owned by the
tenant context. Tracked as migration `0035_impersonation_columns.sql`.

---

## 5. Write-side actor tagging

All tenant write paths use a small wrapper around `activity_log`
inserts. Extend that wrapper to read `session.impersonation` and
serialize it into metadata when present. One change in
`lib/repo/activity.ts`. Every existing call site benefits automatically.

The same wrapper writes a parallel row tagged
`category='security', action='system.impersonation.event'` so the
owner's activity feed surfaces it explicitly (master §5 / open
question 5 → "yes, surface it").

---

## 6. API surface

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/admin/tenants/[id]/impersonate` | super_admin | starts session, returns `{ redirectTo: '/' }` |
| `POST` | `/api/admin/impersonation/exit` | (impersonation cookie) | drops the tenant session, returns `{ redirectTo: '/admin/tenants/[id]' }` |

Note: the **exit** endpoint is callable from within the tenant
session, not the admin session, because it lives at the tenant origin.
It reads the session's `impersonation_admin_id` to know where to
redirect and what to write to audit.

---

## 7. UI

### 7.1 "Start impersonation" confirmation modal

On the tenant detail page → click **Impersonate owner**:

```
⚠ Impersonate {ownerName}

You will log into {tenantName} as {ownerName}. Every action you take
in this session is logged with your name AND theirs.

This is a 30-minute session. You can exit at any time.

Type the tenant name to confirm:
[                                ]

[Cancel] [Impersonate]
```

The "type the tenant name" gate is a deliberate friction step.

### 7.2 Tenant-side `ImpersonationBanner`

Rendered by `AppShell` whenever `session.impersonation` is truthy.

- Fixed at top, full-width, bright red background.
- No dismiss button (it's not optional). Padded so it doesn't break
  the layout.
- Bilingual:
  - AR: "أنت تتصفح المتجر باسم {ownerName} بواسطة الإدارة
        ({adminEmail}). [للخروج اضغط هنا]"
  - EN: "You are viewing this store as {ownerName} via platform
        support ({adminEmail}). [Exit impersonation]"
- The Exit link POSTs to `/api/admin/impersonation/exit` and
  redirects.

### 7.3 Owner-visible impersonation history

On the owner's existing `/activity` (or wherever they audit their
account), surface `system.impersonation.start` and `.end` rows with a
distinct security icon. Filter chip "Security events" optional.

---

## 8. Edge cases (the security-sensitive ones)

| Scenario | Behavior |
| --- | --- |
| Admin tries to impersonate a tenant whose owner account is disabled | 409 `OWNER_DISABLED`. |
| Admin tries to impersonate a suspended tenant | 409 `TENANT_SUSPENDED` — unsuspend first. |
| Impersonation session hits 30-min limit mid-action | Tenant session expires → next request redirects to `/login`. The admin's own session is unaffected. |
| Tenant deleted during impersonation | Next tenant request 404s; admin Exit fallback redirects to `/admin/tenants` (since `[id]` would 404 too). |
| Admin closes the tab without clicking Exit | Tenant session stays alive until the 30-min hard cap. Audit row eventually written by cron when the session expires (`impersonate.timeout`). |
| Admin tries to impersonate while already impersonating someone else | First session is auto-ended (audit row), second starts. |
| Two super-admins impersonate the same owner concurrently | Allowed; two separate sessions, two separate audit chains. |
| Owner deletes their own account during impersonation | Tenant session cascade-deleted; admin Exit → `/admin/tenants/[id]` shows the tenant with "(owner account removed)" already from Spec 02. |
| Admin opens `/admin/*` while in an impersonation session | Works — they have two valid cookies. Admin UI shows a banner reminding them they're mid-impersonation, with a quick link to exit. |
| Race: impersonation start + tenant suspend land in the same second | Suspend wins on next request (tenant proxy enforces). |
| Network partition: admin started impersonation, can't reach `/exit` | Cron auto-revokes sessions past 30 min. Worst case: 30 minutes of unsupervised access. Acceptable because every action is still audited. |

---

## 9. Test plan

### Unit
- Session creation: TTL is exactly 30 min, regardless of base session
  config.
- `activity_log` wrapper preserves `impersonatedBy` on every category.
- Owner selection: prefers the recent-login owner when multiple.

### Integration
- Start impersonation → tenant session row has the impersonation
  payload → GET /api/auth/session returns it.
- Ring up a cash sale during impersonation → `activity_log` row has
  `impersonatedBy=adminId` in metadata.
- 30 min hard cap: synthetic clock jump → next request 401.
- Exit → tenant session row gone, admin session intact.

### Playwright
- Admin starts impersonation → red banner visible on `/dashboard` →
  navigate to `/sales` → red banner still visible → click Exit →
  redirected to `/admin/tenants/[id]`.
- Owner logs into their own account post-session → sees
  `system.impersonation` rows in their `/activity`.

### Security smoke
- Manual: copy the impersonation cookie to another browser → it works
  but only while the original 30 min is unexpired (we accept this; it's
  no different from cookie theft on any session).
- Cookie scope: `__matgary_admin_session` is NOT sent to tenant origin
  paths. Verify via DevTools.

---

## 10. Acceptance criteria

- [ ] Impersonation can be started, used, and exited end to end.
- [ ] Tenant UI always shows the red banner during impersonation, no
      route bypasses it (`AppShell` is mounted on every authed page).
- [ ] Every write produces an `activity_log` row with `impersonatedBy`.
- [ ] Auto-revoke at 30 min works (cron + per-request enforcement
      double-cover).
- [ ] Disabled owner / suspended tenant → 409 with the right code.
- [ ] Owner's `/activity` shows impersonation start/end entries.
- [ ] Migration 0035 applies cleanly to the existing `sessions` table
      without downtime.

---

## 11. Files this spec produces

```
lib/db/migrations/0035_impersonation_columns.sql

lib/admin/impersonation.ts                    (start / exit / cron expiry)
lib/repo/activity.ts                          (wrapper extended)
auth.ts                                       (session callback reads impersonation)

app/api/admin/tenants/[id]/impersonate/route.ts
app/api/admin/impersonation/exit/route.ts

components/admin/ImpersonationConfirmModal.tsx
components/broadcasts/ImpersonationBanner.tsx (tenant-side, NOT under /admin)
components/layout/AppShell.tsx                (mounts the banner)

app/api/cron/admin-session-cleanup/route.ts   (extends to expire impersonation sessions)

dictionaries/ar.json + en.json                (admin.impersonation.*, security.impersonation.*)
```
