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

- **Multi-branch / تعدد الفروع**: `branches` table per tenant; scope products / sales / inventory / employees by branch. The first 2-store owner will ask. Schema-only is ~1 week; with inter-branch transfers and consolidated reports, more.
- **Offline POS mode**: queue sales locally (IndexedDB + service worker) and sync on reconnect. Egyptian internet is unreliable; cashier dead-time when wifi blinks is a switch-back-to-notebook event. ~1–2 weeks of focused work, huge differentiator.
- **Barcode scanner support** at POS. Cheap USB scanners just type into the focused field; the existing search already mostly works. Need a "scan mode" (auto-submit on Enter, fast SKU lookup, focus management). Half-day.
- **Customer ledger** (deferred sales / customer credit). The data is there (sales.isPaid=false); needs a per-customer view + reminders.
- **SMS fallback** alongside WhatsApp. Vodafone Egypt SMS Gateway or EgyptSMS — Twilio is unreliable in Egypt.
- **2FA for owners** (TOTP or WhatsApp OTP).
- **Forgot-username** flow for sub-accounts (`username@tenant-slug` is hard to remember).
- **Bulk product import** from Excel/CSV. Owners arriving from spreadsheet workflows will demand it.
- **Customer loyalty / store credit** programme.
- **Per-branch cash drawer reconciliation** (after multi-branch lands).
- **Staff performance leaderboard improvements**: commissions, targets, bonus calcs.
- **Receipt customisation** beyond message template (logo size, footer copy, language toggle).

### Infrastructure / ops

- **Insights server-side aggregation**: today the overview tab aggregates client-side from `useSales`. Move to `/api/insights?from=…&to=…` with a 60 s tenant-keyed cache. Unlocks bigger date ranges, big speed-up.
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
- **Audit-log retention policy**: today activity_logs grow forever. Add a partition-by-month + drop-after-2-years job.
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
- **Activity log grows forever.** Will hurt query times after a year of busy tenants. Plan partitioning before that.
- **Insights overview aggregation is client-side.** A tenant with 50 k sale rows will see slow page loads. The `useInsights` hook needs to move server-side; the date filter we just added makes that more urgent because it's now a useful page.
- **No offline POS.** First Egyptian wifi outage that costs a customer a sale is a churn risk.
- **No ETA integration.** Cannot serve VAT-registered businesses today. Disclaim or build before charging them.
- **Single-branch only.** Multi-shop owners will switch to a competitor.
- **No real billing.** Cannot legally charge today.
- **No 2FA.** Owner credential compromise = full tenant takeover.
- **No native mobile app.** Browser POS works on phones but UX is mediocre on small screens, and printer/scanner integration needs native.
- **Notifications polling.** Cheap today; will burn battery + bandwidth on phones at scale. Switch to SSE or push when concurrent users matter.
- **Recurring expenses don't auto-spawn.** No scheduler running yet — `next_occurrence_date` is set but nothing reads it. Owners will report "my electricity bill didn't appear this month" eventually.
- **Cache tests skip silently if Redis is unreachable.** Should fail in CI when REDIS_URL is set but unreachable. Today they no-op.
- **Restore drill never run.** I documented how, you haven't done it. Do it once before the first customer signs up.
- **Paymob env keys are empty.** `/billing` shows a clean disabled state until they're provisioned. Until then nothing can actually be charged — explicit by design, but also a launch blocker.
- **No SaaS-invoice generation for tax purposes.** Paymob emails its own receipt; we don't issue our own VAT invoice for the subscription itself. Add when our own VAT registration is filed.
- **No retry / dunning on failed payments.** A `past_due` subscription stays past_due until manually retried by the owner. Email reminders on day 1/3/6 of the grace window are still TODO.
- **No annual / multi-month plans yet.** Only monthly billing.
- **National ID is stored free-form.** No format guard at all (validator dropped by owner). Fine for v1, may surprise an audit later.
- **Phone normaliser is mobile-only.** Egyptian landlines (`02 ...`) are silently rejected (stored as null). If you ever sell to B2B with landline contacts, broaden the regex.
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
