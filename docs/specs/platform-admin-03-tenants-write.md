# Platform Admin — Spec 03: Tenant write actions

Owner: Amr · Drafted: 2026-06-10 · Depends on: **Specs 01, 02**.

Three write actions an admin can take against a tenant: **suspend**,
**unsuspend**, **extend trial**. Every action audited, every action
reflected immediately in the tenant's runtime (suspended tenants get
locked out on the next request).

[master]: ./platform-admin-dashboard.md

---

## 1. Goal

After this spec ships:

- `super_admin` and `ops_admin` can suspend / unsuspend a tenant with
  a mandatory reason.
- Suspended tenants get a hard redirect on their next request:
  `/service-paused?reason=…`.
- Both roles can extend a trial by N days (1 ≤ N ≤ 90).
- The cash-shift sweep and digest cron skip suspended tenants.
- Every action lands in `admin_audit_log` with before/after diff.

---

## 2. Data — no new migrations

The columns added by Spec 01's migration are used here:

- `tenants.suspended_at` — set on suspend, NULL on unsuspend.
- `tenants.suspended_reason` — text required at suspend.

Trial-extend writes to existing columns:

- `subscriptions.trial_ends_at` += `days`.

---

## 3. Repo layer

`lib/admin/tenant-actions.ts`:

```ts
export async function suspendTenant(
  adminId: string,
  tenantId: string,
  reason: string,
  meta: { ip: string; userAgent: string },
): Promise<void>;

export async function unsuspendTenant(
  adminId: string,
  tenantId: string,
  meta: { ip: string; userAgent: string },
): Promise<void>;

export async function extendTrial(
  adminId: string,
  tenantId: string,
  extraDays: number,        // 1..90
  reason: string | null,    // optional but tracked
  meta: { ip: string; userAgent: string },
): Promise<{ newTrialEndsAt: Date }>;
```

Rules:

- Each runs as a single transaction with the corresponding
  `admin_audit_log` insert. Either both succeed or both roll back.
- `suspendTenant` refuses if `suspended_at IS NOT NULL` (409 ALREADY).
- `unsuspendTenant` refuses if `suspended_at IS NULL` (409 NOT_SUSPENDED).
- `extendTrial` refuses if the subscription is not in `trialing` status
  (409 NOT_TRIALING) — for a paying tenant, "extend trial" is meaningless.

Validation:

- `reason.trim().length` must be 5-500 chars on suspend.
- `extraDays` is integer 1-90; reject 0 and negatives explicitly.

---

## 4. API surface

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/admin/tenants/[id]/suspend` | super_admin | body `{ reason }` |
| `POST` | `/api/admin/tenants/[id]/unsuspend` | super_admin | body `{}` |
| `POST` | `/api/admin/tenants/[id]/extend-trial` | super_admin OR ops_admin | body `{ days, reason? }` |

All return the updated tenant payload (same shape as Spec 02's detail
endpoint) so the UI can re-render without a refetch.

---

## 5. Tenant-side enforcement

A small middleware add-on at the **tenant** proxy layer (NOT the admin
proxy):

```
proxy.ts → after auth, before route:
  if (session.tenantSuspendedAt) {
    if (pathname !== '/service-paused') redirect('/service-paused?reason=…');
  }
```

Where does `session.tenantSuspendedAt` come from? The tenant session
already carries a tenant id; the session callback (`auth.ts`) is
extended to fetch `tenants.suspended_at` and bake it into the session
on every issuance. Session TTL is 30 min so a fresh-suspended tenant
gets bounced within at most 30 min.

Force-now path: when an admin suspends a tenant, the API endpoint also
calls `revokeAllTenantSessions(tenantId)` — deletes every NextAuth
session for that tenant from the sessions table. Next request from any
of the tenant's users → fresh login → fresh suspension check → bounced
to `/service-paused`. **Instant** in practice.

New page `app/service-paused/page.tsx` renders a plain "خدمتك متوقفة
مؤقتاً — تواصل مع الدعم" / "Your service is paused — contact support"
card with the reason text and no nav. The route is public (no auth
required) so suspended owners can see the message.

---

## 6. Cron impact

Cash-shift sweep + digest tick already iterate every tenant. Both gain
one filter: `WHERE suspended_at IS NULL`. Suspended tenants don't:

- get owner-desk auto-close runs,
- get stale-shift notifications,
- get the daily digest.

This is the right behavior: don't ping the owner about a tenant we've
paused.

Single-line code change in each cron's tenant-iteration query.

---

## 7. UI

### 7.1 Detail page action buttons (wires them from Spec 02)

The disabled shells from Spec 02 light up:

- **Suspend** — opens a modal: reason textarea (required, 5-500 chars),
  confirm button. The button copy reads "Suspend this tenant — they
  will be locked out immediately."
- **Unsuspend** — opens a confirm modal, no fields. Single click.
- **Extend trial** — modal: days input (number, 1-90, default 14),
  optional reason. Shows "New trial end: <date>" preview.

After any success: toast + page refetch.

### 7.2 Suspended-state hero on tenant detail

If `tenants.suspended_at IS NOT NULL`, the detail page renders a top
banner:

```
⛔ Suspended on 2026-06-10 by admin@matgary.com.
   Reason: "non-payment / abuse / etc."
```

Followed by the standard detail blocks (still shown — admin needs to
see them to investigate).

### 7.3 Suspended tenant in list view

Status badge = "Suspended" (red). Filter chip "Suspended" already wired
in Spec 02 (added as an enum value there).

---

## 8. Edge cases

| Scenario | Behavior |
| --- | --- |
| Admin tries to suspend an already-suspended tenant | 409 `ALREADY_SUSPENDED` |
| Admin tries to unsuspend an active tenant | 409 `NOT_SUSPENDED` |
| Admin tries to extend trial on a paying tenant | 409 `NOT_TRIALING` |
| Admin tries to extend trial past 90 days in one call | 400 `TOO_MANY_DAYS` |
| Stacked extensions (3× 30-day calls) | All valid; each is a separate audit row. |
| Suspended tenant's user is mid-session | First request after suspend → instant redirect (sessions revoked). |
| Tenant suspended while owner is in checkout | Paymob webhook still posts; we honor it but the tenant stays suspended. Owner contacts support. |
| Service-paused page accessed without `?reason=` | Renders a generic "service paused" message; doesn't 404. |
| Admin reads suspended reason | Returned verbatim. Reason text never sent to the public landing page. |

---

## 9. Test plan

### Unit
- `suspendTenant` flips both columns + writes one audit row.
- `extendTrial` clamps + computes the new date correctly (DST-safe).
- `unsuspendTenant` on a non-suspended tenant → throws `NOT_SUSPENDED`.

### Integration
- Suspend tenant T → next request as one of T's users redirects to
  `/service-paused`.
- Unsuspend → next request renders normally.
- Cash-shift sweep skips suspended tenants (assert no new
  `cash_shifts.status='closed'` rows for T during sweep).
- Digest tick skips suspended tenants (no `digest_runs` insert).

### Playwright
- Admin suspends a test tenant → opens incognito as owner → bounced to
  `/service-paused`.
- Admin extends a trial → trial end date on detail page updates.

---

## 10. Acceptance criteria

- [ ] Suspending a tenant produces 1 audit row + revokes sessions.
- [ ] Suspended tenant cannot access any authenticated route within
      30 s of the suspension write.
- [ ] Trial extension updates `subscriptions.trial_ends_at` and lands
      a precise before/after in audit.
- [ ] Both crons (cash-shift-sweep, digest-tick) skip suspended
      tenants.
- [ ] `/service-paused` renders correctly in AR + EN with no auth.

---

## 11. Files this spec produces

```
lib/admin/tenant-actions.ts

app/api/admin/tenants/[id]/suspend/route.ts
app/api/admin/tenants/[id]/unsuspend/route.ts
app/api/admin/tenants/[id]/extend-trial/route.ts

app/service-paused/page.tsx
proxy.ts                                        (1 conditional added)
auth.ts                                         (session callback adds suspendedAt)

app/api/cron/cash-shift-sweep/route.ts          (1-line filter)
app/api/cron/digest-tick/route.ts               (1-line filter)

components/admin/SuspendTenantModal.tsx
components/admin/ExtendTrialModal.tsx
components/admin/SuspendedBanner.tsx

dictionaries/ar.json + en.json                  (admin.tenantActions.*, servicePaused.*)
```
