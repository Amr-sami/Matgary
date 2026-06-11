# Platform Admin — Spec 02: Tenants overview + list + detail (read-only)

Owner: Amr · Drafted: 2026-06-10 · Depends on: **Spec 01**.

The first "I can actually see something" slice. After this spec ships,
a logged-in admin can browse the entire platform — KPIs at a glance,
searchable list of every tenant, and a drill-down detail page per
tenant. No write actions yet (those live in Spec 03).

Read [master §2][master] for the security/RLS rules. Every query in
this spec runs through `lib/admin/db.ts` (BYPASSRLS), never
`withTenant()`.

[master]: ./platform-admin-dashboard.md

---

## 1. Goal

Logged-in admin can:

1. Open `/admin` and see 5 KPIs + 3 lists + 2 charts at a glance.
2. Click "Trials expiring" → land on `/admin/tenants?status=trialing&trialExpiringIn=7`.
3. Open `/admin/tenants`, filter by status / plan / branch count,
   search by tenant name, owner email, owner phone.
4. Click any row → `/admin/tenants/[id]` with the full read-only view.
5. See **Health Flags** on the detail page that surface signals from
   the features we already shipped (cash reconciliation, daily digest,
   cash shifts).

No writes. The action buttons on the detail page exist as disabled
shells; Spec 03 wires them up.

---

## 2. Data — no new migrations

Everything reads from existing tables:

- `tenants`, `tenant_members`, `users`, `branches`
- `subscriptions`, `subscription_payment_attempts`
- `sales` (for last sale + MRR proxy)
- `cash_shifts` (for the "shifts open > 24h" health flag)
- `digest_runs` (for the "digest configured?" health flag)
- `activity_log` (for "recent owner activity")

Read access only. Spec 01's `app_admin` role already has SELECT on all
of these.

---

## 3. Repo layer

`lib/admin/tenants.ts` exposes:

```ts
export async function listPlatformOverview(): Promise<OverviewPayload>;

export interface TenantListFilters {
  status?: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'suspended';
  plan?: PlanKey;
  branchCount?: '1' | '2-3' | '4+';
  trialExpiringInDays?: number; // 0 < n <= 30
  q?: string;       // free-text on tenant name, owner email, owner phone
  sort?: 'created_at' | 'last_login' | 'mrr';
  limit?: number;   // default 50
  offset?: number;
}

export async function listTenants(filters: TenantListFilters): Promise<TenantListRow[]>;

export async function getTenantDetail(tenantId: string): Promise<TenantDetailPayload>;
```

Implementation rules:

- All numeric aggregations done in SQL — `coalesce(sum(...)::numeric, 0)::text`.
- Every query has an explicit index hit. No table scans on `sales` —
  use `sales_tenant_branch_date_idx`.
- The detail call is one round-trip composed of CTEs (no N+1 across
  branches × cash_shifts × digest_runs).

---

## 4. API surface

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/admin/overview` | any | KPI payload (§5). Cached 30s per admin via Redis. |
| `GET` | `/api/admin/tenants` | any | Filters, paged. Default 50. |
| `GET` | `/api/admin/tenants/[id]` | any | Full detail payload (§7). |
| `GET` | `/api/admin/tenants/[id]/employees` | any | All `tenant_members` rows with `users.last_seen_at`. |
| `GET` | `/api/admin/tenants/[id]/activity` | any | last 50 activity_log entries for this tenant. |

All return JSON. No paging on the detail sub-endpoints (each tenant
has bounded employee/activity counts at this scale).

---

## 5. `/admin` Overview UI

### 5.1 KPI row

Five cards across the top:

| Card | Value | Subline |
| --- | --- | --- |
| Total tenants | count | "+N this week" |
| Trialing | count | "M expiring in 7d" |
| Active paid | count | "+N this week" |
| MRR (EGP) | sum | "+₤N this week" |
| Today signups | count | "▲X% wow" |

`wow` = week-over-week. `MRR` = sum of active subscriptions' monthly
price. (NOT a Paymob settlement total — that's revenue, different
metric.)

### 5.2 Three lists

1. **Trials expiring next 7 days** — top 5, click → filtered tenants
   page.
2. **Recent payment failures** — last 10 from `subscription_payment_attempts`
   where status='failed' in last 30 days, with a "View tenant" link.
3. **Recent admin activity** — last 10 `admin_audit_log` rows.

### 5.3 Two charts

- **Per-plan distribution** — donut: trial / professional / multi_branch.
- **Signups over last 30 days** — sparkline using existing chart helpers.

---

## 6. `/admin/tenants` list UI

- Search bar (`q`) — matches tenant name, owner email, owner phone.
- Filter chips (reuse the inventory pattern):
  - All / Trialing / Active / Past due / Cancelled / Suspended.
- Plan filter (Trial / Professional / Multi-branch).
- Branch count filter (1 / 2-3 / 4+).
- "Trial expiring within" select (3 / 7 / 14 days).
- Columns:
  - Tenant name
  - Owner (name + email)
  - Owner phone
  - Plan
  - Branches (count)
  - Employees (count)
  - Last login (relative)
  - MRR
  - Status badge
- Click row → tenant detail.
- URL state mirrors filters so a tab can be bookmarked / shared.

---

## 7. `/admin/tenants/[id]` detail UI

Same focused layout as the master spec §7.4 sketch. Three vertical
sections:

### 7.1 Identity header

- Tenant name (large), slug.
- Owner row: name · email · phone (tap-to-copy).
- Created at · last login · last sale (relative).
- Action buttons (disabled in this spec, wired in Spec 03):
  - **Suspend** / **Unsuspend**
  - **Extend trial**
  - **Impersonate** (wired in Spec 07)
  - **View tenant activity** (link to `/admin/tenants/[id]/activity`)

### 7.2 Plan & billing card

- Status badge + plan + monthly price + next renewal date.
- Last payment row: status · amount · provider · date.
- Failed attempts (last 90 d) count.

### 7.3 Branches table

- One row per branch: name · active · employees · last sale.

### 7.4 Health flags rollup

The interesting part — surfaces cross-feature signals so support sees
the same picture the owner sees.

| Flag | Condition |
| --- | --- |
| Cash reconciliation off everywhere | `shop_settings.cash_reconciliation_enabled = false` on every branch |
| Shifts open > 24 h | any `cash_shifts.status='open' AND opened_at < now() - 24h` |
| Digest not configured | `digest_settings.enabled=false OR owner_phone IS NULL` |
| No sales in last 7 days | `max(sales.sale_date) < now() - 7d` |
| Employees with no login in 30 d | `count(users) where last_seen_at < now() - 30d` |

Each row renders ✓ / ⚠ with the count + a one-line hint.

### 7.5 Recent admin actions on this tenant

Last 10 rows from `admin_audit_log` where
`target_kind='tenant' AND target_id=<id>`.

### 7.6 Recent owner activity

Last 10 rows from the existing `activity_log` table.

---

## 8. Edge cases

| Scenario | Behavior |
| --- | --- |
| Tenant has 0 branches (shouldn't happen but rare) | Show empty state in branches table, don't crash. |
| Tenant created < 1 hour ago | "Last login" shows "—", relative time shows "just now". |
| Owner deleted (deleted-account row) | Identity header shows "(owner account removed)" in red. |
| Tenant has 200+ employees | Employees endpoint returns first 200 with a "+N more" badge. |
| MRR sum overflows int | `numeric(14,2)`; safe through ₤999B. |
| `subscription_payment_attempts` has malformed rows | Each row defensively typed; bad rows logged + skipped. |
| `?q=` injection attempt | Drizzle parametrises; never raw concatenation. |
| Filter combination yields 0 results | Empty state matches inventory's pattern: "No tenants match this filter". |

---

## 9. Test plan

### Unit
- `listTenants` filter matrix: status + plan + branch count combinations.
- MRR computation: one trial + one active + one cancelled tenant → MRR
  equals active monthly price only.
- Health flag predicates each isolated.

### Integration
- Seed 3 tenants (trial / active / cancelled), GET `/api/admin/overview`,
  assert KPI math.
- Filter `?status=trialing` returns only the trial tenant.
- Detail endpoint returns the same data via two different request shapes
  (verifies CTE composition).

### Playwright
- Admin logs in, lands on `/admin`, sees the 5 cards rendered with
  non-placeholder numbers.
- Searches by owner email substring → finds tenant.
- Drills in, sees Health Flags rendered for a tenant with an
  intentionally-misconfigured branch.

---

## 10. Acceptance criteria

- [ ] `/api/admin/overview` returns a real payload (no mock data).
- [ ] List page renders 50+ tenants with all filters working.
- [ ] Detail page renders for any tenant ID; all 5 health flags
      compute correctly against seeded data.
- [ ] Action buttons render but are disabled with a tooltip "wired in
      Spec 03 / Spec 07".
- [ ] No tenant query in this spec uses `withTenant()` — every read is
      via `lib/admin/db.ts`.
- [ ] Smoke: open `/admin/tenants` in production, scan a random tenant,
      no PII bleeds across (i.e. tenant A's data doesn't appear in
      tenant B's detail).

---

## 11. Files this spec produces

```
lib/admin/tenants.ts                          (repo)
lib/admin/overview.ts                         (KPI aggregator)
lib/admin/health-flags.ts                     (rollup predicates)

app/admin/page.tsx                            (replaces Spec 01 placeholder)
app/admin/tenants/page.tsx                    (list)
app/admin/tenants/[id]/page.tsx               (detail)
app/admin/tenants/[id]/activity/page.tsx      (long activity view)

app/api/admin/overview/route.ts
app/api/admin/tenants/route.ts
app/api/admin/tenants/[id]/route.ts
app/api/admin/tenants/[id]/employees/route.ts
app/api/admin/tenants/[id]/activity/route.ts

components/admin/OverviewCards.tsx
components/admin/TenantListTable.tsx
components/admin/TenantDetailHeader.tsx
components/admin/TenantHealthFlags.tsx
components/admin/TenantBranchesTable.tsx

dictionaries/ar.json + en.json                (app.admin.overview.*, .tenants.*)
```
