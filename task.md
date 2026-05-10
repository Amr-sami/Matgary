# Matgary — task & status log

Living document. Tracks what the app currently is, what we built recently, what's next, and what we'll probably need later. Updated at the end of each working session — newest log entry on top.

> **How to read this file**
>
> - Section 1 is a snapshot of the product (capabilities, surface area, infra).
> - Section 2 is the changelog — what shipped, when, and why.
> - Section 3 is the prioritized "what's next" list (week-by-week).
> - Section 4 is the longer-tail "we'll probably want this" backlog.
> - Section 5 is known gaps & risks — be honest with yourself here.

---

## 1. What the app is today

Multi-tenant Arabic-first SaaS POS / store management for the Egyptian market. Each "tenant" is one shop. Owners onboard, invite staff with granular permissions, run sales, manage inventory, send WhatsApp receipts.

### 1.1 Stack

- **Framework**: Next.js 16.2.3 (App Router, RSC, server actions, JWT-strategy NextAuth v5 beta).
- **DB**: Postgres 16 with **Row-Level Security forced** on every tenant-scoped table. Drizzle ORM. App role is NOSUPERUSER so RLS bites.
- **Cache / rate-limit**: Redis 7 (opportunistic — every helper falls back to source-of-truth on Redis outage).
- **Auth**: Auth.js v5 (credentials provider only; no OAuth yet). JWT in cookies. `mustChangePassword` flow for admin-set passwords.
- **Locale**: RTL Arabic UI. Currency EGP. Timezone Africa/Cairo.
- **Hosting**: Self-hosted (planned). Local dev via docker-compose. Production Dockerfile uses Next.js standalone output.

### 1.2 Tenant scoping & RLS

- Every scoped table has `tenant_id uuid` + an RLS policy `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`.
- `lib/db/index.ts:withTenant(tenantId, fn)` opens a transaction and `set_config('app.tenant_id', …, true)` for the duration. Application code still filters by `tenant_id` explicitly — RLS is the safety net, not the primary gate.
- App connection uses `APP_DATABASE_URL` (the `matgary_app` NOSUPERUSER role); migrations + tests use `DATABASE_URL` (admin).

### 1.3 Permission model

Per `lib/permissions.ts`:

- Roles: `owner` | `staff` (in `tenant_members.role`).
- Owner has every permission implicitly (`isOwner` check). Staff have an explicit array in `tenant_members.permissions`.
- Permission catalog covers page-visibility (`view_*`) and action capabilities (`manage_*`, `record_*`, etc.).
- Helpers: `can(principal, perm)`, `canAny(principal, perms)`. Server-side gate via `lib/api/auth-helpers.ts:requireTenant()` / `requirePermission()`.

### 1.4 Feature surface

| Area | Routes | Repo files | Notes |
|---|---|---|---|
| Auth | `(auth)/login`, `/signup`, `/forgot-password`, `/reset-password`, `/onboarding` | `lib/auth.ts`, `lib/repo/team.ts`, `lib/repo/password-reset.ts`, `lib/mailer.ts` | Credentials only. Forgot-password tokens in Redis (30 min TTL, SHA-256 hashed). Login + signup + password endpoints rate-limited. |
| Dashboard | `/` | client-aggregated | Onboarding redirect via session flag. |
| Inventory / catalog | `/inventory`, `/add-product`, `/api/products/*`, `/api/categories/*`, `/api/brands/*`, `/api/attributes/*` | `lib/repo/catalog.ts`, `lib/repo/catalog-admin.ts` | Categories with optional attributes (e.g. clothing has gender + size). Brands per-category. Stock adjustments leave a `product_history` trail. Catalog reads cached (5 min TTL); writes auto-bust. |
| Sales / POS | `/sales`, `/api/sales/*`, `/api/sales/cart` | `lib/repo/operations.ts` | Cart endpoint is the real path. Tracks discounts (line + order), payment method (cash/instapay/card/deferred), customer name+phone, recordedByUserId for staff attribution. Returns a structured per-line summary used by the activity log. |
| Returns | `/returns`, `/api/returns` | `lib/repo/operations.ts` | One return per sale row, partial-quantity allowed. |
| Customers | `/customers` | derived from `sales.customer_*` snapshots | No standalone customers table yet — phone is the de-facto identity. |
| Expenses | `/expenses`, `/api/expenses/*` | `lib/repo/operations.ts` | One-off + recurring (monthly/weekly). Recurring template spawns child instances on schedule (currently no scheduler — manual). |
| Suppliers | `/suppliers`, `/api/suppliers/*` | `lib/repo/suppliers.ts` | Running balance per supplier (POs received minus supplier-tagged expenses). |
| Purchase orders | `/purchases`, `/api/purchase-orders/*` | `lib/repo/purchase-orders.ts` | Draft → received (bumps stock + supplier balance) / cancelled. Date filter on the page. |
| Tasks | `/tasks`, `/api/tasks/*` | `lib/repo/tasks.ts` | Manager assigns; assignee gets unread badge; owner sees all. |
| Leave requests | `/team?tab=leaves` (merged from `/leave`) | `lib/repo/leave-requests.ts` | Staff submit; manager approves/rejects. Notifications fire on submit + decision. `/leave` URL still works (server redirect). |
| Team / employees | `/team` (sub-tabs: team / attendance / payroll / leaves / settings) | `lib/repo/team.ts`, `lib/repo/attendance.ts`, `lib/repo/payroll.ts` | Owner adds staff via username (auto-formed login `username@tenant-slug`). National ID + photo upload. `mustChangePassword` set on admin-created accounts. Compensation history per employee. |
| Attendance | `/team?tab=attendance`, `/api/attendance/*` | `lib/repo/attendance-events.ts`, `lib/repo/attendance.ts` | Self-recorded check-in/out via geofence (lat/lng + radius) or manual (permission-gated). Manager reconciles missed check-outs. Geofence rejections are logged to the activity feed. |
| Payroll | `/team?tab=payroll` | `lib/repo/payroll.ts` | Fixed / hourly / hybrid pay types. Effective-from versioning so a salary change doesn't rewrite history. Period generator (manual today). |
| WhatsApp | `/api/whatsapp/send`, `/send-pdf` | `lib/repo/settings.ts` (Green API creds) | Per-tenant Green API instance. Token stored encrypted (`SECRET_KEY`-derived AES). Rate-limited 30/min/tenant across both endpoints. |
| Insights | `/insights` (overview + staff tabs) | `hooks/useInsights.ts`, `app/api/insights/*` | Date-filtered overview metrics + staff leaderboard. Trend chart capped at 90 daily buckets for readability. **Aggregation is still client-side except for staff-performance** — server cache deferred until that moves. |
| Activity log | `/activity`, `/api/activity` | `lib/repo/activity.ts`, `lib/activity-labels.ts` | Owner-visible audit feed of every meaningful mutation. Tenant-scoped + RLS. Action namespace `category.verb` (e.g. `sale.create`). Metadata rendered as human Arabic key/value pairs, not JSON. |
| Settings | `/settings` | `lib/repo/settings.ts` | Shop name, phone, logo, WhatsApp creds, message template. Cached 5 min, busted on save. |
| Marketing | `(marketing)/welcome`, `/about`, `/contact`, `/blog`, `/help`, `/status`, `/privacy`, `/terms` | static | Privacy + TOS rewritten to be PDPL-aware (Egyptian Law 151/2020). |

### 1.5 Cross-cutting infrastructure

#### Cache layer (`lib/cache.ts`, `lib/redis.ts`)

- Single shared ioredis client on `globalThis`. Eager connect, retry caps at 2 s.
- Strict key scheme: `matgary:<env>:<v1>:<scope>:<rest>` where `scope` is `t:<tenantId>` for tenant-scoped or `g` for global. Builders `tenantKey()` / `globalKey()` are the only sanctioned way to mint keys.
- Helpers: `cacheGet`, `cacheSet`, `cacheDel`, `cacheRemember`, `cacheBustPrefix`, `cacheBustTenant`. All errors swallowed → cache is opportunistic.
- `cacheBustPrefix` refuses prefixes shorter than 8 chars (typo guard).
- Bump `CACHE_VERSION` in `lib/cache.ts` to mass-invalidate after a shape change.
- `CACHE_DISABLED=1` env kill-switch. `CACHE_DEBUG=1` logs every hit/miss.

**Active caches:**
- `shop_settings` — 5 min TTL, busted on `saveShopSettings`.
- User context (`resolveTenantContext` for JWT callback) — 60 s TTL, busted on team/permission/onboarding/password mutations via `bustUserContextCache(userId)`.
- Catalog (categories, attributes, brands) — 5 min TTL, busted by every catalog-admin write.

**Deliberately not cached** (yet): products list, notifications, insights aggregates. Reasons documented in `task.md` § 4.

#### Rate limiting (`lib/ratelimit.ts`)

- Atomic sliding-window via Redis ZSET + Lua. Returns `{ ok, count, resetAt }`.
- **Fail-open**: Redis down → returns `{ ok: true }`. Availability over a few un-throttled seconds.
- `rateLimit(scope, identifier, opts)` for peek-or-consume; `rateLimitConsume()` for forced commit.

**Active limits:**
- `login.ip` 10 / 15 min
- `login.email` 5 / 15 min (only failed attempts consume; pre-check before bcrypt)
- `pwd.change` 5 / 1 hr / user
- `pwd.reset` 10 / 1 hr / actor
- `pwd.forgot` 5 / 1 hr / IP
- `pwd.reset.token` 20 / 1 hr / IP
- `signup.ip` 5 / 1 hr / IP
- `wa.send` 30 / 1 min / tenant (shared between `/send` and `/send-pdf`)

#### Activity log

- Schema: `activity_logs` (tenant_id, actor_user_id, actor_name snapshot, action, category, entity_type, entity_id, entity_label, metadata jsonb, ip, created_at). RLS forced.
- `logActivity({ ... })` is fire-and-forget — internal try/catch so audit failure cannot break a parent mutation.
- Wired into: auth.login, auth.logout, auth.password_change, team.add/update/delete/password_reset/compensation_set, settings.update, settings.attendance_update, leave.submit/approve/reject, product.create/update/delete/adjust, sale.create (cart endpoint), expense.create, supplier.create, attendance.check_in/check_out/geofence_rejected.
- Page shows category chip + Arabic action label + actor + relative time, plus per-action metadata formatter that turns JSON into human key/value rows (e.g. for `sale.create`: invoice number, line items, total, payment method, customer name+phone).

#### Auth flow

- Login: credentials provider in `lib/auth.ts:authorize`. Pre-checks rate limits before bcrypt. JWT callback runs `resolveTenantContext` (cached 60 s) and logs `auth.login` on first issue.
- Logout: `logoutAction` in `app/(auth)/actions.ts` — captures session before signOut, logs `auth.logout`.
- Forgot password: `/forgot-password` form → `/api/account/password/forgot` issues 32-byte token (raw to email, SHA-256 in Redis 30 min TTL) → email link → `/reset-password?token=…` → `/api/account/password/reset` validates, sets bcrypt hash, busts user context cache, deletes token.
- Mailer: `lib/mailer.ts` nodemailer SMTP wrapper. Without `SMTP_HOST` it logs to console — dev flows are testable without an inbox.

#### Backups (`infra/backup.sh`, `infra/restore.sh`, `docker-compose.yml:backup` service)

- Sidecar runs `pg_dump | gzip` daily at 02:30 UTC into `./backups/`.
- Retention: 14 daily + 8 weekly (Sunday dumps tagged `weekly-*`).
- Atomic write via `.partial` rename + 1 KB minimum size sanity check.
- Off-site shipping via `BACKUP_REMOTE_HOOK` env var (script gets the dump path as `$1`). Stays out of compose so secrets live on the host.
- Restore script refuses to run without `RESTORE_CONFIRM=1`. Documented restore drill in `task.md` § 1.6.
- **Initial dump runs immediately** if `./backups/` is empty so a fresh deploy is protected before the first scheduled tick.

#### Test database safety

- `tests/isolation.test.ts` truncates everything as part of setup. **Refuses to run** unless `TEST_DB_WIPE=1` *and* `DATABASE_URL` contains "test" — both required. Both conditions exist because we lost real data once already.
- Cache test suite (`tests/cache.test.ts`) is non-destructive and runs unconditionally when Redis is reachable.

#### Production deployment

- `Dockerfile` is multi-stage: deps → builder → runner. Final image uses Next.js standalone output (~280 MB), runs as non-root, exposes `:3000`.
- `output: "standalone"` set in `next.config.ts`.
- `infra/nginx.conf.example` — TLS termination template with HSTS, X-Frame-Options, modern certbot integration. Body limit 25 MB for image/PDF uploads. WebSocket upgrade headers for HMR (dev) / Next streaming.
- `.dockerignore` excludes `.git`, `.next`, `node_modules`, `backups`, `tests`, env files.

#### Sentry

- `sentry.{server,edge,client}.config.ts` — env-gated. Without `SENTRY_DSN` (server/edge) or `NEXT_PUBLIC_SENTRY_DSN` (client) Sentry is a no-op so dev stays quiet.
- Sample rate defaults to 10% (`SENTRY_TRACES_RATE`). Replays disabled by default; `SENTRY_REPLAYS=1` enables on-error replays only.

### 1.6 Operational cheatsheet

```bash
# Bring everything up
docker compose up -d

# Run app locally
CACHE_DEBUG=1 npm run dev

# Inspect Redis
docker exec matgary-redis redis-cli
> KEYS matgary:*

# Check most recent backup
ls -lh backups/

# Manual backup right now
docker exec matgary-backup /usr/local/bin/backup.sh

# Restore drill (use a throwaway DB, not the live one)
docker run --rm -d --name pg-test -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
docker exec pg-test psql -U postgres -c "CREATE DATABASE matgary_restore;"
PGHOST=localhost PGPORT=55432 PGUSER=postgres PGPASSWORD=test \
  PGDATABASE=matgary_restore RESTORE_CONFIRM=1 \
  ./infra/restore.sh ./backups/<file>.sql.gz

# Type check
npx tsc --noEmit

# Tests (cache only — isolation suite is hard-gated)
npx vitest run tests/cache.test.ts
TEST_DB_WIPE=1 DATABASE_URL=postgres://.../matgary_test npx vitest run  # full suite

# Generate a migration after editing lib/db/schema.ts
npx drizzle-kit generate
# Then edit the generated SQL — the snapshot drifts because earlier migrations
# were hand-written. Strip everything except the new diff before committing.
npm run db:migrate
```

---

## 2. Changelog

### 2026-05-11 — Customer loyalty + store credit (نقاط الولاء / رصيد العميل)

Unified wallet: one `customer_wallets` row per (tenant, branch, phone) holding both points and EGP credit, with an append-only `customer_wallet_events` audit log. Each branch runs its own programme (multi-store).

- **Schema** (`0016_customer_loyalty.sql`):
  - `customer_wallets` (composite PK on tenant/branch/phone) + `customer_wallet_events` log. Both RLS-forced.
  - Three new shop_settings cols: `loyalty_enabled`, `loyalty_points_per_egp` (earn rate), `loyalty_egp_per_point` (redeem rate). Disabled by default. Optional `loyalty_expiry_days` for the future expiry cron.
- **Repo** (`lib/repo/loyalty.ts`):
  - `getWallet(tenantId, branchId, phone)` returns `{ wallet, events }` — zero-balance default when no row exists.
  - `earnPoints / redeemPoints / applyCredit` are tx-scoped helpers used inside `recordCartSale`. Refuse to make either balance negative; write the event + update the wallet in the same tx.
  - `grantCredit(...)` opens its own tx for the owner-only manual grant path. Refuses without a non-empty reason.
- **Sale flow** (`recordCartSale`):
  - Two new options: `redeemPoints`, `applyCreditEgp`. Refused without a customer phone OR if loyalty is disabled OR balance is short.
  - Loyalty discount treated as another order-level discount layer for the proportional per-line allocation. If the requested redemption exceeds what's left after order discount, the cart helper trims (preserves credit, reduces points) so we never produce negative-total invoices.
  - After the sale lands, points are awarded on the FINAL paid amount (after every discount including the loyalty discount itself — points never compound). Deferred sales don't earn points (the customer hasn't actually paid yet).
- **API**:
  - `GET /api/customers/by-phone/[phone]/wallet` — balance + recent events.
  - `POST /api/customers/by-phone/[phone]/credit` (owner-only) — manual grant/deduct with required reason. Activity log: `loyalty.credit_grant` / `loyalty.credit_deduct`.
  - `POST /api/sales/cart` schema accepts `redeemPoints` + `applyCreditEgp`.
- **UI**:
  - **Settings page** — "برنامج الولاء" card with enable toggle + earn/redeem rate inputs + a live "100 EGP earns X points worth Y EGP" example.
  - **Customer detail page** — wallet card with points + credit big numbers, "= X EGP discount potential" hint when redeem rate is set, owner-only "إضافة / خصم رصيد" form (reason required), event history list.
  - **SaleForm** — when loyalty is enabled AND a customer phone is entered, a loyalty box appears showing balances + two inputs (redeem points / apply credit). Wallet fetched with 400ms debounce on phone change so a fast typist doesn't spam the endpoint.

**Trade-offs flagged:**
- Loyalty applies before order discount but the per-line `discountAmount` field stores the combined allocation. Receipts show one "discount" line; per-source breakdown lives in `customer_wallet_events`. Future iteration could add explicit fields to `sales` for per-source split.
- Offline-queued sales with redemption are best-effort: if the wallet drops between queue and sync, the row goes to `failed`. Fine for v1.
- No expiry cron yet — schema supports `loyalty_expiry_days` and `points_expire` events, but the actual sweeper isn't wired. Add when first owner reports a customer hoarding points.
- No "refund as credit" flow yet (schema reserves `credit_refund` event kind). Add when returns UI gets a credit-instead-of-cash toggle.

### 2026-05-10 — Customer ledger (دفتر العملاء / المبيعات الآجلة)

Owners had every deferred sale's data in `sales.isPaid=false` but no view that aggregated it per customer. Now there's a real ledger.

- **`lib/repo/customers.ts`** — `getCustomerLedger(tenantId, branchId, phone)` rolls every non-returned sale for one (branch, phone) into `{ invoices: [...], lifetimeValue, outstandingBalance, paidBalance, firstVisit, lastVisit }`. Multi-store: scoped to active branch on purpose — owner switches branches via the topbar to see the same customer's debt at the other store separately.
- **`markCustomerAllPaid(tenantId, branchId, phone)`** — atomic bulk mark-paid. Idempotent; returns `{ markedCount, markedTotal }` for the activity log + UI toast.
- **`GET /api/customers/by-phone/[phone]`** — ledger detail endpoint. Phone is URL-encoded; route normalises via `normalizeEgyptPhone` so the URL form matches whatever shape was stored on the sale row.
- **`POST /api/customers/by-phone/[phone]/mark-all-paid`** — bulk mark-paid endpoint. Permission: `modify_sales` (same as the single-sale path). Activity log: `sale.mark_paid` with `bulk: true`.
- **`/customers/[phone]` page** — header (name, phone, outstanding in big red, lifetime/paid/invoice-count/last-visit stat row), per-invoice list with per-invoice "تأكيد الدفع" + WhatsApp reminder, bulk "تأكيد دفع الكل" + "تذكير بكل الآجل" + "رسالة شكر". Unpaid invoices highlighted with an orange tint.
- **`CustomerRow`** updated: every customer with a phone gets an "إدارة الآجل" / "ملف العميل" CTA linking to the detail page (orange when there's debt, neutral otherwise). WhatsApp shortcuts on the list now substitute the **real shop name** from `useShopSettings` instead of the hardcoded "Corner Store" that was leftover from the seed preset.

### 2026-05-10 — Offline POS (queue + service worker + idempotent sync)

The cashier dead-time when wifi blinks is no longer a switch-back-to-notebook event.

- **IndexedDB outbox** (`lib/offline/db.ts`, `lib/offline/outbox.ts`) via Dexie. Two tables: `outbox` (queued mutations with `pending`/`syncing`/`synced`/`failed` status, atomic-claim transitions, capped retries with backoff) and `snapshot` (per-(tenant, branch) read cache). All-`pending` rows GC themselves 60s after sync.
- **Server idempotency** (`lib/api/idempotency.ts`) — every offline-queued sale carries a UUID `Idempotency-Key`. Server caches the response in Redis (24h TTL, key namespaced by tenant + idempotency-key) so a flaky sync that retries the same row never creates two charges. 4xx errors are also cached so a stuck row doesn't loop forever.
- **POS bootstrap** (`/api/pos/bootstrap`) returns the active branch's products + categories. Cart page refreshes it on mount and every 5 min, so when wifi blinks the catalog is already on disk.
- **Service worker** (`public/sw.js`) — hand-rolled, no Workbox. Cache-first for static assets (Next hashes filenames so stale cache is safe); network-first with cache fallback for HTML navigations; never intercepts `/api/*`. Registered only in production (HMR + SW conflict in dev).
- **Sync engine** (`hooks/useOffline.ts`) drains the outbox on `online` event, tab focus, and a 30s polling tick (belt-and-braces). Counts surface live to the topbar.
- **Topbar indicator** (`<OfflineIndicator />`) self-hides when healthy. Orange offline ("غير متصل · N بانتظار"), blue while syncing ("جارٍ المزامنة"), red on failure with manual-retry button.
- **Cart integration** (`recordCartSaleOfflineAware` in `lib/offline/recordCartSale.ts`) — generates a UUID idempotency key + a client-side `INV-…` invoice id so the receipt the customer walks out with matches the eventual server record. `SaleForm` switched off `lib/api/sales:recordCartSale` to this offline-aware path.
- **Multi-store safety**: outbox row carries `branchId` of where the sale was rung up. Server refuses replay (`X-Outbox-Branch` mismatch) if the cashier later switched branches mid-sync — prevents inventory drifting between stores.
- **`recordCartSale` now accepts an optional client-supplied `invoiceId`** in options (validated by regex). Used only by the offline path; the existing online path still lets the server pick.

**Honest "still owed" list** (none of this blocks the basic flow, but worth tracking):
- Cart's product picker still reads from `useProducts` (network). When offline the snapshot is on disk but the picker shows nothing — small UI follow-up to swap in `readSnapshot()`.
- No "discard / retry single failed row" UI yet — the indicator does a global retry; per-row management lives in code (`outbox.ts:discard/retry`) but not wired to UI.
- Service worker only registers in production. To smoke-test offline: `npm run build && npm start`.
- Conflict resolution (two cashiers sold the last unit while one was offline) — server currently throws and the row goes `failed`. Industry-standard "accept the sale, flag negative stock" flow is a future iteration.

### 2026-05-10 — Multi-store (sub-tenant) isolation — `0015_multi_store_isolation.sql`

Promoted "branches" from the chain-store model (shared catalog, per-branch sales) to a true multi-store model: each branch is now a fully isolated shop under one billing account. Adding a product or employee to "cairo" doesn't appear in "main".

- **Migration adds `branch_id` to**: `categories`, `brands`, `category_attributes`, `category_attribute_values`, `products`, `product_attribute_values`, `suppliers`, `tasks`, `leave_requests`, `notifications`. All NOT NULL post-backfill (notifications nullable for tenant-wide system pings).
- **`shop_settings` PK changed** from `(tenantId)` to `(tenantId, branchId)`. Each branch has its own header/logo/WhatsApp credentials/message template.
- **`tenant_members.branch_ids[]` collapsed to single `branch_id`** (legacy column kept one deploy for safety). Owner: NULL = implicit access to every branch. Staff: NOT NULL = locked to that branch only.
- **`branches.slug`** added — `"main"` for primary, derived-name+random-suffix for additional. URL-safe identifier within the tenant.
- **`product_stock` table dropped** + the trigger. Multi-store: a product belongs to ONE branch and carries its own quantity directly.
- **Backfill semantics**: every existing row → primary branch. New branches start completely empty (no products, categories, employees) — the owner sets them up from scratch, matching the user-mental-model "two stores under one account".
- **API + UI rewired**:
  - Every list endpoint (`/api/products`, `/api/categories`, `/api/brands`, `/api/sales`, `/api/expenses`, `/api/returns`, `/api/suppliers`, `/api/tasks`, `/api/leave-requests`, `/api/team`, `/api/settings`) defaults to the active branch via `resolveBranchFilter()`. Owner can pass `?branchId=all` for the consolidated view (returns 403 for staff).
  - Every write endpoint (`POST /api/categories`, `POST /api/brands`, `POST /api/products`, `POST /api/suppliers`, `POST /api/tasks`, `POST /api/leave-requests`, `POST /api/team`, `PATCH /api/settings`, `POST /api/expenses`, `POST /api/sales/cart`, `POST /api/products/[id]/adjust`, `POST /api/whatsapp/send*`) routes through `requireTenantWithBranch()` and tags the row with the active branch.
  - **Sidebar header** now shows the active branch name large with the tenant name as a small uppercase subtitle when >1 branch exists.
  - **`/settings/branches`** has a "فتح" button per row to switch directly. The eye/eye-off icons replaced the older confusing alert/check pair for enable/disable.
  - **Employee form** — "الفرع" picker is now a single-select (was checkbox list). Email format stays tenant-wide (`username@tenant-slug`) so moving Ahmed between branches is just an edit, no password reset.
  - **`/settings`** owner card "إدارة الفروع" links to the branches page so single-store owners can discover the feature without the picker showing up.

**Trade-offs we deliberately took** (the "unlogic things" the user asked me to flag):
- Categories per-branch = double-typing for owners running similar stores. Acceptable for true franchise model (different stores).
- Customers + suppliers stay tenant-wide via `sales.customer_phone` and `suppliers.branch_id` (suppliers tagged but addressable across branches). A future iteration can lock these too if owners report cross-branch surprises.
- Email domain stays tenant-wide intentionally — branch-locked emails would force a password reset every time a staff member moves stores.

### 2026-05-09 — Multi-branch (تعدد الفروع) — schema, API, UI, sales path

Six-phase rollout in one session. Multi-branch is the foundation; consolidated reports and inter-branch transfers stay deferred per the doc's original scope.

- **Phase 1 — schema + migration** (`0014_multi_branch.sql`):
  - New tables: `branches` (id, tenantId, name, address, phone, isActive, isPrimary), `product_stock` (per (product, branch) qty + lowStockThreshold), both with RLS forced and tenant-isolated.
  - Partial unique index `branches_one_primary_per_tenant_idx ON branches (tenant_id) WHERE is_primary` enforces "exactly one primary per tenant" at the DB level.
  - `branch_id` columns added (nullable for backwards-compat) to `sales`, `expenses`, `purchase_orders`, `attendance_events`, `store_locations`, `activity_logs`. Indexes `(tenant_id, branch_id, date)` for the per-branch report path.
  - `tenant_members.branch_ids uuid[]` — staff allow-list. Owners ignore the column at runtime; backfilled to `[primary]` so existing logins keep working.
  - Trigger `sync_product_total_quantity` on `product_stock` keeps `products.quantity` as a denormalised sum, so the global inventory view continues to work without code changes.
  - Backfill: every existing tenant gets a primary branch ("الفرع الرئيسي"), every historical sale/expense/PO/attendance row points at it, every product gets a stock row with the existing quantity at the primary branch.
- **Phase 2 — active-branch context** (`lib/api/branch-context.ts`, `lib/api/auth-helpers.ts`):
  - HttpOnly `mg.branch` cookie carries the active branch UUID; server validates against the user's allow-list on every read. Tampered cookie just falls back to the user's primary.
  - `getAccessibleBranches(ctx)` cached 60 s in Redis; busted on branch CRUD and on staff branch-list edits.
  - New `requireTenantWithBranch()` helper returns `{ tenantId, branchId, branchName, isPrimaryBranch, allowedBranchIds }` — used by every branch-scoped write path.
- **Phase 3 — branch CRUD repo + API**:
  - `lib/repo/branches.ts`: list/get/create/update/disable/delete. Delete refuses primary; refuses any branch with referenced rows (returns per-table count so the UI can show "12 sales, 3 attendance events on this branch").
  - `GET /api/branches` returns `{ data, currentBranchId }`; `POST /api/branches` (owner-only); `PATCH/DELETE /api/branches/[id]` (owner-only); `POST /api/branches/select` flips the cookie.
  - Activity log: `branch.create/update/disable/enable/delete/switch` with Arabic labels. `logActivity` learned an optional `branchId` field that lands on `activity_logs.branch_id` for context.
- **Phase 4 — UI**:
  - `<BranchPicker />` (`components/branches/`) in the topbar. Self-hides when the tenant has only one branch — single-store owners never see the multi-branch concept. Owner gets a "إدارة الفروع" link to the settings page.
  - `/settings/branches` — owner CRUD (create, edit, enable/disable, delete with conflict-count toast). Primary branch protected from disable/delete.
  - Team form (`EmployeeFormModal`) shows a "الفروع المسموح بها" multi-select when the tenant has >1 branch. Defaults to primary on new staff. Server validates every id belongs to the tenant before persisting.
- **Phase 5 — per-branch sales/expenses/inventory**:
  - `recordSale`, `recordCartSale` now require `branchId` from `requireTenantWithBranch()`. Stock check + decrement go against `product_stock` for that branch only — selling more than the branch has on hand throws "غير متوفرة في هذا الفرع" even if global stock would have covered it.
  - `recordReturn` re-credits at the parent sale's branch, not the user's currently-active branch — prevents inventory drifting between branches without an explicit transfer.
  - `addExpense` accepts an optional `branchId`; the route resolves explicit > active and refuses null (tenant-wide) for non-owners.
  - `addProduct` seeds `product_stock` rows for every branch in the tenant — initial qty at the active branch, 0 elsewhere — so the table stays dense.
  - `createBranch` backfills `product_stock=0` for every existing product so a newly-added branch starts dense.
  - Reusable `adjustBranchStock(tx, tenantId, branchId, productId, delta, opts)` helper — used by every stock-moving path.
- **Phase 6 — insights branch filter**:
  - `loadInsightsOverview(tenantId, window, branchId)` — `branchId=null` aggregates every branch (owner only on the route); a uuid restricts to that branch. Cache key includes branch so an owner viewing "all" doesn't see a cached single-branch slice.
  - `/api/insights/overview` accepts `?branchId=all` (owner only) or `?branchId=<uuid>` (validated against allow-list); defaults to active branch from cookie context.
  - Insights page gets a small `هذا الفرع | كل الفروع` toggle for owners when the tenant has >1 branch.

### 2026-05-09 — Activity-log retention sweep

- **`POST /api/cron/activity-log-cleanup`** new route. Same auth surface as the recurring-expenses cron (bearer-token + per-IP rate limit). Reads `ACTIVITY_LOG_RETENTION_DAYS` (default 730 = 2 years, clamped 30..3650) and deletes everything older than the cutoff.
- **`pruneTenantActivity(tenantId, cutoff)`** + **`pruneActivityAllTenants(cutoff)`** in `lib/repo/activity.ts`. Per-tenant prune runs inside `withTenant` so the existing RLS policy is the gate even for the janitor — we cannot accidentally delete another tenant's rows. Chunked (10 k rows / round-trip, 50 rounds max) so a long purge doesn't take a wide lock.
- **Sidecar wiring**: docker-compose `cron` service learned a generic `poke-cron.sh` wrapper; the crontab has two entries now (hourly recurring-expenses + nightly 03:30 activity cleanup). One env file, one secret, two pokes.
- **Honest scope note**: this is the retention half of the gap. The "partition by month" half is documented in §4 backlog (still owed when a single tenant pushes the table past a few hundred GB — well after launch).

### 2026-05-09 — Cache test fail-loud + Egyptian landline normaliser

- **`tests/cache.test.ts`** now pings Redis in `beforeAll` when `redis` is non-null. A `REDIS_URL`-set-but-unreachable run throws with the connection error instead of letting every assertion silently no-op (the cache helpers swallow errors by design — exactly the failure mode CI was supposed to catch). Local devs without `REDIS_URL` keep the skip behaviour with a `console.warn` hint.
- **Defensive guard**: if `REDIS_URL` is set but `lib/redis` somehow returned null (a future refactor regression), the suite throws instead of skipping.
- **`lib/validators/egypt.ts`**: added `normalizeEgyptLandline`, `normalizeEgyptPhoneAny`, `isValidEgyptPhoneAny`. Landline path accepts 7–9 digits starting with 2–9 (after country-code stripping), so Cairo `02 ...`, Alexandria `03 ...`, and governorate codes (13/15/40/45/.../97) all canonicalise to `+20<digits>`. Mobiles still take the strict path. Existing strict call sites (POS customer phone, team phones) deliberately untouched — `Any` is opt-in for B2B / supplier-style fields where landlines are common.

### 2026-05-09 — Notifications: polling → SSE with Redis pub/sub

- **`GET /api/notifications/stream`** new SSE endpoint. Authenticates via the same `requireTenant` helper, sends an initial snapshot, then subscribes to a per-user Redis channel (`notif:user:{userId}`) and refetches+emits on every published marker. Heartbeat comment every 25 s, hard-cap at 5 min (client `EventSource` auto-reconnects).
- **`lib/notifications/events.ts`** new helper. `publishUserNotificationEvent(userId)` is fire-and-forget; `subscribeUserNotificationEvents(userId, onMessage)` allocates a duplicated ioredis client (subscribe blocks the connection), returns an idempotent `unsubscribe`. Both functions degrade to no-op when Redis isn't configured.
- **Mutation publishers**: `createNotification` (so all transactional callers — leave, tasks — get pushed for free), `markNotificationRead`, `markAllNotificationsRead`, `markReadByKind` now publish after the work is done. Send is `void`-prefixed and never thrown — a publish failure can't break a notification mutation.
- **`useNotifications` hook**: SSE-first with polling fallback. After two consecutive `EventSource.error` events it gives up, closes the stream, and falls back to the original 60 s polling loop so the bell still updates on enterprise proxies that strip `text/event-stream`. Optimistic mark-read is unchanged.
- **Stream fallback path on the server**: when Redis is unreachable, the route still works — it polls the DB at 15 s instead of subscribing to pub/sub. The client never has to know.
- **nginx template**: new `location = /api/notifications/stream` block with `proxy_buffering off` + `proxy_read_timeout 6m`. Placed before the catch-all `/` block so nginx matches it first. The route already sends `X-Accel-Buffering: no` as a belt-and-braces signal.

### 2026-05-09 — Recurring-expense scheduler (sidecar cron)

- **`POST /api/cron/recurring-expenses`** new route. Iterates every tenant, calls the existing `materializeDueRecurringExpenses` materialiser, returns `{ tenants, totalSpawned, failures, results[] }`. Failures on one tenant don't abort the sweep.
- **Auth**: shared bearer token in `Authorization: Bearer …`, `timingSafeEqual`'d against `CRON_SECRET`. Refuses when the env var is unset (no implicit open mode). POST-only so it isn't browsable, cacheable, or accidentally hit by a link prefetcher.
- **Rate limit**: 6 calls / hour / source IP via the existing Redis sliding-window. Mitigates the "leaked secret hammers the materialiser" scenario without affecting the legitimate hourly cron.
- **Activity log**: emits `expense.recurring_materialized` with the spawn count for any tenant where ≥1 row was created. Actor name "نظام (جدولة)" so owners see this is the system, not a person. Arabic label added in `lib/activity-labels.ts`.
- **Middleware allowlist**: `/api/cron/*` added to `PUBLIC_PREFIXES` so the bearer-token check stays the only gate (no JWT or subscription wall in front of cron pokes).
- **Compose sidecar**: new `cron` service in `docker-compose.yml`. Plain alpine + crond + curl. Reads `CRON_SECRET` and `CRON_TARGET_URL` from env, materialises a 0700 wrapper that sources a 0600 env file (so the secret isn't visible in the crontab listing or process args), schedules the hourly poke. `extra_hosts: host.docker.internal:host-gateway` makes it reach the app on the Docker host on Linux too.
- **Materialiser changes**: `materializeDueRecurringExpenses` exported and now returns `{ spawned: number }` for the cron route's accounting. Existing lazy call from `listExpenses` ignores the return value — same behaviour as before.

### 2026-05-09 — Insights overview moved server-side

- **`/api/insights/overview`** new route. Permission-gated by `view_insights`. Strict Zod input: `from`/`to` are ISO 8601 + offset, must be both-or-neither, `from <= to`, capped at 2 years to bound the trend grouping. Errors are logged server-side (no leakage to the client).
- **`lib/repo/insights.ts:loadInsightsOverview()`** — six SQL aggregates inside one `withTenant` transaction (current revenue, prior-period revenue, window totals incl. cost/discount/expenses, top 5 products, category breakdown, daily trend with zero-fill). Result tenant-cached for 60 s via `cacheRemember(tenantKey(t, "insights:overview", from, to))`. RLS still bites since aggregates ride the same `withTenant` setup.
- **Cost of goods now prefers the snapshot.** SQL chooses `nullif(sales.cost_price_at_sale, '')::numeric` first, then falls back to `nullif(products.cost_price, '')::numeric`, then 0. The old client always used the *current* product cost — a price update silently rewrote last month's profit. Snapshot makes historical reports stable; legacy rows without a snapshot keep the old behaviour.
- **`useInsights` hook is now a thin fetcher.** No more `useSales`/`useReturns`/`useProducts`/`useExpenses` calls from the page — the browser used to download every row just to compute six numbers (multi-MB JSON for big tenants). Same return shape so the page didn't change.
- **Cache invalidation wired** into every write path that could move a number: `recordSale`, `recordCartSale`, `updateSale`, `voidSale`, `recordReturn`, `addExpense`, `deleteExpense`, `bulkDeleteSales`, and the lazy `materializeDueRecurringExpenses` materialiser when it actually spawns a row.

### 2026-05-07 — Week 2 + Week 3 (billing + Egypt-specific)

- **Billing tables** — `subscriptions` (1:1 per tenant) and `payment_attempts` added with RLS forced. Migration `0013_absurd_warpath.sql` applied.
- **Plan catalog** in `lib/payments/plans.ts`: `trial` / `professional` (299 EGP/mo) / `multi_branch` (placeholder, not purchasable yet). 14-day trial constant lives here too.
- **Paymob adapter** (`lib/payments/paymob.ts`): full 3-step Accept-iframe flow (auth → register order → payment_keys), HMAC-SHA512 webhook verification with constant-time compare, `merchant_order_id` packs `tenantId:planKey:timestamp` for round-trip identification. Env-gated — without `PAYMOB_API_KEY/INTEGRATION_ID/IFRAME_ID/HMAC_SECRET` every entry point returns `{ kind: "not_configured" }` and `/billing` shows a clean disabled state.
- **Subscription lifecycle** (`lib/repo/subscriptions.ts`): `ensureSubscription` (idempotent trial start), `recordPendingAttempt`, `settleAttempt` (idempotent on `paymobTransactionId` so webhook redelivery can't double-credit), `cancelSubscription`. `signupAction` now calls `ensureSubscription` so every fresh tenant starts the 14-day clock.
- **Trial gate in middleware** — JWT now carries `subscriptionAccessActive` + `subscriptionStatus`. Middleware redirects every non-billing route to `/billing` when access lapses; APIs return `402 SUBSCRIPTION_REQUIRED`. `/billing`, the Paymob webhook, and the password-change flow remain reachable so the owner can recover.
- **`/billing` page** — owner-only. Status card (trial days left / next renewal / past-due warning / cancelled-until-end), purchasable plans, payment-history list, cancel button. Calls `/api/billing/subscribe` → Paymob iframe redirect. Empty state when Paymob isn't configured.
- **Paymob webhook** (`/api/billing/paymob/webhook`) — HMAC-verifies, settles the matching pending attempt (or inserts a settled row if none matched), bumps subscription period on success, flips active→past_due on failure, busts the user-context cache for every tenant member so the next request reflects new state without the 60s TTL gap.
- **Activity log: billing.* events** — `billing.checkout_started`, `billing.payment_succeeded`, `billing.payment_failed`, `billing.cancelled` with Arabic labels.
- **Egyptian phone normaliser** (`lib/validators/egypt.ts`) — coerces `01...`, `+201...`, `00201...`, `+20 100 …`, Arabic-Indic digits all to canonical `+201XXXXXXXXX`. Applied to `addTeamMember` / `updateMemberPermissions` (team form) and `customerPhone` in `POST /api/sales/cart`. **Deliberately NOT applied to signup-form validation** per owner's call — keeps the front door light. National ID validator dropped from scope by owner's decision.
- **ETA disclaimer (Path B)** — sales `Receipt` now prints "إيصال للأغراض التشغيلية — ليس فاتورة ضريبية إلكترونية معتمدة من ETA" in 8pt at the bottom; landing-page footer carries a longer Arabic notice. Signup form left untouched.
- **Thermal printer print rules** — `@page { size: 80mm auto }` so Chrome's print dialog defaults to the right paper. Existing 72mm content width inside that page is unchanged.

### 2026-05-07 — Week 1 launch readiness

- **Production Dockerfile + nginx template** — multi-stage build, `output: "standalone"`, non-root runtime user, body limit + security headers in nginx vhost.
- **Forgot-password flow** — `/forgot-password` + `/reset-password` pages, API endpoints, Redis-backed tokens, nodemailer SMTP wrapper with dev console fallback. Public paths whitelisted in middleware. Privacy-preserving (always returns 200 from `/forgot`, no enumeration).
- **Sentry env-gated** — server, edge, client configs. No-op without DSN.
- **Backups + restore drill** — sidecar service, daily+weekly retention, off-site hook, restore safety guard. Initial dump verified end-to-end.
- **Privacy + TOS rewritten** for Egyptian PDPL (Law 151/2020): controller identity, lawful basis, rights catalogue, retention periods, breach notification, child-data, cross-border. Tax-related disclaimer added to TOS (e-invoicing not yet integrated).

### 2026-05-07 — Cache & rate-limit fan-out

- **Catalog cache** for categories, attributes, brands. Auto-bust on every catalog-admin write.
- **Rate limits** added: signup (per IP), own password change, admin password reset, WhatsApp send (per tenant, shared scope).

### 2026-05-07 — Redis foundations

- `docker-compose.yml` redis service on host port 6381 (avoids local 6379/6380 conflicts), `allkeys-lru` eviction, no persistence.
- `lib/redis.ts` shared client.
- `lib/cache.ts` helpers — `cacheRemember`, `cacheBustPrefix`, tenant-key builder, prefix-length guard.
- `lib/ratelimit.ts` Lua sliding-window, fail-open.
- **Settings cache** (5 min TTL).
- **User-context cache** for the JWT callback (60 s TTL); bust helpers wired into team/password/onboarding mutations.
- **Login rate limit** (10/IP, 5/email, both per 15 min, only failed attempts consume).
- **Tenant-isolation cache test suite** (`tests/cache.test.ts`) — 4 tests verifying keys don't bleed across tenants and `cacheBustPrefix` honours its safety guard.

### 2026-05-07 — Test wipe safety guard (post-incident fix)

- Lost real dev data: `npx vitest run` triggered `tests/isolation.test.ts:beforeAll` which `TRUNCATE`s every table. Hard-gated the wipe behind `TEST_DB_WIPE=1` *and* DB URL containing "test". Both must hold; either alone is a no-op.

### 2026-05-07 — Insights date filter (both tabs)

- `useInsights(window?)` accepts an optional `{ from, to }`. When set, every metric (current revenue, growth, totals, top products, category pie, trend chart) recomputes inside the window, with growth comparing to the immediately preceding window of equal length.
- Trend chart caps at 90 daily buckets so multi-month custom ranges stay readable.
- Staff tab honours the same window via the existing `/api/insights/staff-performance` API. Internal 7d/30d/90d toggle removed in favour of the page-level filter.

### 2026-05-07 — Purchases date filter

- Same date-preset bar (today/yesterday/7d/30d/this month/custom) on `/purchases`. Filters on `receivedDate ?? orderDate` to match the existing display label.

### 2026-05-07 — Sales product-search UX

- `ProductSearchSelect` now syncs its internal search input with the parent-controlled `value`. After "إضافة للفاتورة" the search clears; after a "recent products" quick-pick, the search reflects the picked product. User typing without a selection is unaffected.

### 2026-05-07 — Navbar reorg

- Primary (always visible): Dashboard, Inventory, Sales, Add Product, Purchases, Insights.
- Secondary (under "المزيد"): Tasks, Customers, Expenses, Suppliers, Returns, Team, Activity, Settings.
- Permission gates and the special cases for `/tasks` (every authed user) and `/team` (anyone with manage_team OR request_leave OR manage_leave) preserved.

### 2026-05-07 — Leaves merged into Team

- New "leaves" sub-tab inside `/team`. Tabs filter by perms — staff with only `request_leave` see only the leaves tab and the page label flips to "الإجازات".
- `/leave` is now a thin server-component redirect to `/team?tab=leaves` so existing notification deep-links still work.
- Standalone "الإجازات" navbar entry dropped; the unread badge migrated to `/team`.

### 2026-05-07 — Activity log

- `activity_logs` table + RLS migration `0012_silly_namorita.sql`.
- New permission `view_activity_log` (owner implicit; assignable to staff).
- `lib/repo/activity.ts:logActivity()` — fire-and-forget with internal try/catch. `listActivity`, `listActivityActors`, action+category Arabic labels (split into `lib/activity-labels.ts` for client safety).
- `/activity` page with date-range / actor / category filters, "load more" keyset pagination, expandable per-row details rendered as Arabic key/value pairs (not raw JSON).
- Wired into ~15 mutations (see § 1.5 → activity log).
- For `sale.create`, extended `recordCartSale` to return per-line product summaries + customer name + phone + total + payment method, all surfaced in the log details.

### 2026-05-07 — LAN dev access fix

- Next.js 16 blocks cross-origin `/_next/*` requests by default; phone-on-LAN couldn't hydrate.
- Added `allowedDevOrigins: ["192.168.1.42", "192.168.1.*"]` in `next.config.ts`.
- Recommended `npm run dev -- -H 192.168.1.42` when testing from a phone on the LAN; otherwise NextAuth redirect URLs use `localhost`/`0.0.0.0` and break cross-device.

---

## 3. What's next (paid-launch path)

### Week 1 ✅ done
Backups + restore drill, forgot-password, Sentry, production Dockerfile + nginx template, PDPL-aware privacy + TOS.

### Week 2 ✅ done (Paymob env keys still empty — fill when account is provisioned)
Paymob adapter, subscriptions + payment_attempts schema, trial start on signup, trial gate in middleware, /billing page + plan picker + history, webhook handler with HMAC verify + cache bust, billing.* activity log entries.

### Week 3 ✅ done (national ID validator dropped per owner; signup form intentionally untouched)
ETA disclaimer on receipts + landing footer (Path B), thermal-printer @page sizing, Egyptian phone normaliser applied to team + sale customer phone.

### Week 3.5 — what to do as soon as Paymob credentials are issued

- [ ] Fill `PAYMOB_API_KEY`, `PAYMOB_INTEGRATION_ID`, `PAYMOB_IFRAME_ID`, `PAYMOB_HMAC_SECRET` in `.env`.
- [ ] Configure Paymob's "Transaction Response Callback" URL → `https://<your-domain>/api/billing/paymob/webhook` and "Redirection URL" → `https://<your-domain>/billing`.
- [ ] Run a 1-EGP test charge end-to-end: subscribe → iframe → success → `/billing` shows the new period → activity log shows `billing.payment_succeeded`.
- [ ] Test the failure path with a deliberately wrong CVV → `billing.payment_failed` with reason populated.
- [ ] Test webhook idempotency by replaying the same webhook (`curl` the same body twice) → second call should be a noop.

### Deferred from Week 3 — re-evaluate after first paying customers

- [ ] **ETA e-invoicing Path A** (real integration with مصلحة الضرائب). Two-week effort. Triggered when the first paying customer asks for tax-compliant invoices.
- [ ] **ESC/POS native printer support** (Expo or Tauri companion). Browser print works for now; revisit when at least 3 customers complain.
- [ ] **Failed-payment dunning emails** (day 1/3/6 of grace). Subscription flips to `past_due` already; email reminders are still TODO.

### Week 4 — Closed beta

- [ ] **Recruit 5 friendly stores** for unpaid (or half-price) beta. Set expectations: rough edges, weekly check-ins, direct WhatsApp line for support.
- [ ] **Onboarding video** (Arabic, 90 s).
- [ ] **Support inbox**: dedicated email, monitored at least daily.
- [ ] **Weekly metrics review**: signups, conversion to paid, login frequency, support tickets, top errors in Sentry.

---

## 4. Probably-need-soon backlog

Ordered roughly by likely impact on retention / conversion. Not committed — revisit before each sprint.

### Product

- ~~**Multi-branch / تعدد الفروع**: foundation~~ ✅ Done 2026-05-09. **Still owed**: inter-branch stock transfers (move qty A → B with audit), consolidated multi-branch P&L beyond the simple "كل الفروع" toggle (e.g. side-by-side comparison), per-branch payroll separation, attendance + purchase-order branch wiring (currently still backfill-only — phase 5.5).
- ~~**Offline POS mode**~~ ✅ Done 2026-05-10. **Still owed**: cart's product picker should fall back to the snapshot when offline (data is there, UI doesn't read it yet); per-row discard/retry UI for failed outbox rows; conflict-resolution flow when stock has gone negative across branches at sync time.
- **Barcode scanner support** at POS. Cheap USB scanners just type into the focused field; the existing search already mostly works. Need a "scan mode" (auto-submit on Enter, fast SKU lookup, focus management). Half-day.
- ~~**Customer ledger**~~ ✅ Done 2026-05-10 — per-customer detail page at `/customers/[phone]`, per-invoice + bulk mark-paid, WhatsApp reminders that use the active branch's shop name. Per-invoice WhatsApp deep-links scoped to the active branch only — owner switches branches to see the same customer's debt at the other store.
- **SMS fallback** alongside WhatsApp. Vodafone Egypt SMS Gateway or EgyptSMS — Twilio is unreliable in Egypt.
- **2FA for owners** (TOTP or WhatsApp OTP).
- **Forgot-username** flow for sub-accounts (`username@tenant-slug` is hard to remember).
- **Bulk product import** from Excel/CSV. Owners arriving from spreadsheet workflows will demand it.
- ~~**Customer loyalty / store credit** programme.~~ ✅ Done 2026-05-11. Unified wallet (points + EGP credit) per (tenant, branch, phone) with audit log. Per-branch enable + rates in settings. Earn auto on paid sales, redeem at checkout, owner manual grant. **Still owed**: points expiry cron, "refund as credit" toggle in returns flow.
- **Per-branch cash drawer reconciliation** (after multi-branch lands).
- **Staff performance leaderboard improvements**: commissions, targets, bonus calcs.
- **Receipt customisation** beyond message template (logo size, footer copy, language toggle).

### Infrastructure / ops

- ~~**Insights server-side aggregation**: today the overview tab aggregates client-side from `useSales`. Move to `/api/insights?from=…&to=…` with a 60 s tenant-keyed cache.~~ ✅ done 2026-05-09 — see changelog.
- **/healthz + /readyz endpoints** for nginx / orchestrator probes.
- **Structured logging** (pino or similar). Replace `console.log` in repo + API.
- **Metrics endpoint** (Prometheus exposition or push to Grafana Cloud free tier). Track: cache hit rate, DB pool utilisation, API p50/p95, login success/failure ratio.
- **CI pipeline**: GitHub Actions running typecheck + cache test on every PR. Isolation suite against a docker-postgres ephemeral DB on main.
- **Staging environment** that mirrors prod but runs against a snapshot of last week's backup.
- **WAL archiving for PITR**: drop RPO from 24 h to ~5 min. Adds operational complexity — skip until first paying customers.
- **Object storage for uploads** (team photos, store logos). Today they live on the app server's filesystem. Bind-mount for now is fine; S3-compatible (MinIO self-hosted, Hetzner Object) when traffic demands.
- **CDN for static assets**.

### Security / compliance

- **PDPL data-export endpoint**: download-everything-as-zip.
- **Account deletion** (real delete, not just disable). Schedule + 30 day grace.
- **Audit-log retention policy**: drop-after-2-years half is done (cron route + sidecar). Partition-by-month is still TODO — useful once any single tenant pushes the table past a few hundred GB (well after launch).
- **Password reset email throttle by email** (today only by IP — an attacker rotating IPs could harvest usage info; the always-200 mitigates but it's belt + suspenders).
- **Session revocation UI** ("sign out all other devices"). JWT makes this hard — needs a token-version column on users that the JWT carries, increment to force re-login.
- **CSP headers** in nginx + Next.
- **Penetration test** before charging.

### Testing

- Today: 4 cache tests + 11 isolation tests = 15 total. **Not enough for a SaaS that handles money.**
- E2E suite (Playwright): signup → onboarding → add product → record sale → check insights, all in one flow.
- Repo-level unit tests for sale recording (especially discount math), payroll period calc, leave date overlap.
- Load test of `/api/sales/cart` POST (representative payload, simulate 50 concurrent cashiers across 10 tenants). Tells us when we'll need read-replica or queueing.

---

## 5. Known gaps & risks

- **No staging.** Every change is one bad migration away from production data loss. Backups mitigate but don't replace this.
- **No real CI/CD.** Deploys are manual.
- ~~**Activity log grows forever.**~~ ✅ Retention sweep shipped 2026-05-09 (daily cleanup, default 2y). Native PG partitioning still owed once a single tenant crosses ~hundreds of GB — see §4 backlog "Audit-log retention policy" item.
- ~~**Insights overview aggregation is client-side.**~~ ✅ Resolved 2026-05-09 — moved to `/api/insights/overview` with 60 s tenant cache.
- ~~**No offline POS.**~~ ✅ Resolved 2026-05-10 — IndexedDB outbox + service worker + idempotent sync. Cashier rings up offline, drains automatically when wifi returns. Picker-from-snapshot when offline still owed (snapshot is on disk, the cart's product picker just doesn't read it yet — small UI follow-up).
- **No ETA integration.** Cannot serve VAT-registered businesses today. Disclaim or build before charging them.
- ~~**Single-branch only.**~~ ✅ Multi-branch foundation shipped 2026-05-09 — branches CRUD, picker in topbar, per-branch inventory + sales + expenses + insights filter, staff branch allow-list. Inter-branch transfers and consolidated reports beyond a simple all-branches insights toggle stay in §4 backlog.
- **No real billing.** Cannot legally charge today.
- **No 2FA.** Owner credential compromise = full tenant takeover.
- **No native mobile app.** Browser POS works on phones but UX is mediocre on small screens, and printer/scanner integration needs native.
- ~~**Notifications polling.**~~ ✅ Resolved 2026-05-09 — SSE stream backed by Redis pub/sub. Polling kept as a fallback when EventSource keeps failing.
- ~~**Recurring expenses don't auto-spawn.**~~ ✅ Resolved 2026-05-09 — `POST /api/cron/recurring-expenses` (bearer-auth, rate-limited) + `cron` sidecar in docker-compose pokes it hourly. Lazy catch-up on `listExpenses` retained as a belt-and-braces second path.
- ~~**Cache tests skip silently if Redis is unreachable.**~~ ✅ Resolved 2026-05-09 — `beforeAll` pings Redis when configured; ping failure throws with the underlying error.
- **Restore drill never run.** I documented how, you haven't done it. Do it once before the first customer signs up.
- **Paymob env keys are empty.** `/billing` shows a clean disabled state until they're provisioned. Until then nothing can actually be charged — explicit by design, but also a launch blocker.
- **No SaaS-invoice generation for tax purposes.** Paymob emails its own receipt; we don't issue our own VAT invoice for the subscription itself. Add when our own VAT registration is filed.
- **No retry / dunning on failed payments.** A `past_due` subscription stays past_due until manually retried by the owner. Email reminders on day 1/3/6 of the grace window are still TODO.
- **No annual / multi-month plans yet.** Only monthly billing.
- **National ID is stored free-form.** No format guard at all (validator dropped by owner). Fine for v1, may surprise an audit later.
- ~~**Phone normaliser is mobile-only.**~~ ✅ Resolved 2026-05-09 — `normalizeEgyptLandline` + `normalizeEgyptPhoneAny` shipped. Strict mobile path retained for SMS/WhatsApp recipients; broader path is opt-in.
- **Trial gate uses a JWT claim with 60s TTL.** A user who pays at the moment their trial expires may see one stale page render before the cache busts. Acceptable trade — alternatives all add request-time DB hits.

---

## 6. Decision log

Things we explicitly decided (and the why) so we don't relitigate.

| Decision | Reason | Date |
|---|---|---|
| Self-host on a single server (planned) | Cost, control, owner expertise | 2026-05-07 |
| Postgres + RLS as primary tenancy gate | Defence-in-depth: app filters + RLS + NOSUPERUSER role | (pre-existing) |
| ioredis (not Upstash REST) | Self-hosted future, Edge runtime not needed for cache today | 2026-05-07 |
| Cache opportunistic, never authoritative | Redis outage must not bring app down | 2026-05-07 |
| Rate limiter fail-open, not fail-closed | Locking everyone out on a Redis blip is worse than 30 s of unrate-limited login | 2026-05-07 |
| Activity log fire-and-forget | Audit failure must not break the parent mutation | 2026-05-07 |
| Tenant key MUST include tenantId | Cache RLS-bypass is the easiest disaster | 2026-05-07 |
| Test wipe needs both env + URL match | One env var alone is too easy to set accidentally; learnt the hard way | 2026-05-07 |
| Path B (disclaim, not integrate) on ETA for v1 | Time-to-market over completeness; recommit when first paying VAT-registered customer asks | TBD (week 3 call) |
| Plan tiers gated through Paymob, not Stripe | Stripe doesn't process cards issued by Egyptian banks reliably | 2026-05-07 |
| Drop national-ID validator entirely | Owner's call — adds friction without proportional value pre-launch | 2026-05-07 |
| Don't tighten signup-form validation | Owner's call — keep the front door frictionless; normalise on write at non-signup boundaries | 2026-05-07 |
| Path B (disclaimer) chosen for ETA — v1 ships without integration | Ship now, narrow market to non-VAT-registered stores; revisit when first VAT-registered customer asks | 2026-05-07 |
| Phone normaliser fails open (junk input → null, not rejection) | Phone is optional everywhere; rejecting a sale because of a bad customer phone hurts the cashier more than it helps the owner | 2026-05-07 |
| Webhook bust user-context cache for every member, not just owner | Staff session may be active during checkout; flipping subscription state for the owner alone leaves staff seeing stale "trial expired" view | 2026-05-07 |
| Webhook idempotency keyed on `paymobTransactionId` | Paymob occasionally re-delivers; doubling a paid month is worse than skipping a duplicate | 2026-05-07 |

---

## How to use this file going forward

- Update Section 2 (Changelog) at the end of every working session, newest entry on top.
- Move items from Section 3 (Next) to Section 2 when shipped.
- Promote items from Section 4 (Backlog) to Section 3 when scheduled.
- Add to Section 5 (Gaps) any time you notice something but can't fix it yet — "known and tracked" beats "we forgot."
- Append to Section 6 (Decisions) any non-obvious choice the team makes, with the reason.
