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
- `pwd.forgot.email` 3 / 1 hr / sha256(email) — H10, belt + suspenders on the IP bucket
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

### 2026-06-03 — H06 money math unit tests

- **Extracted pure discount math** out of `lib/repo/operations.ts` into `lib/repo/sale-discounts.ts`: `calcLineDiscount`, `calcOrderDiscount`, `calcCartTotals`. Production code now delegates to them; behaviour byte-identical (same `Math.round` half-up rounding, same `min(discount, subtotal)` cap, same `"fixed" | "percentage"` discriminator). 13 unit tests cover line / order / stacked / free-item edge / negative-input / rounding direction.
- **Extracted payroll compute** into `lib/repo/payroll-compute.ts` (`computeGrossFromShifts` + `CompensationDto` + `pickEffectiveCompensation`). `payroll.ts` re-exports the DTO and picker so existing call sites stay unbroken. The DTO+picker moved into the new file (not vice-versa) to break what would have been a circular import. 10 unit tests cover empty / hourly weekday / hourly overtime / weekend-as-OT / fixed monthly pro-rate / hybrid / mid-period rate change.
- **Real finding — leave overlap detection does not exist.** `submitLeaveRequest` only enforces `startDate <= endDate`. The same employee can submit and an owner can approve two overlapping leaves with zero warning. Added to §4 backlog ("Leave overlap detection") and §5 known gaps. H06 spec's leave-overlap acceptance row dropped accordingly — testing math that does not exist would be theatre.
- **CI wiring.** `.github/workflows/pr.yml` now runs `npx vitest run tests/cache.test.ts tests/ratelimit.test.ts tests/repo/`. New tests pick up automatically when added under `tests/repo/`. Total runtime: 23 new tests in ~650 ms.

### 2026-06-03 — H02 CI pipeline (GitHub Actions)

- **`.github/workflows/pr.yml`** runs on every PR: `npm ci` → `npx tsc --noEmit` → lint (informational) → Redis-gated vitest specs (`cache.test.ts` + new `ratelimit.test.ts`). Single Redis 7 service container. `cache: npm` for `~/.npm`.
- **`.github/workflows/main.yml`** runs on push to `main`: above + Postgres 16 service container with `matgary_test` DB → applies `infra/init-postgres.sql` to provision the `matgary_app` NOSUPERUSER NOBYPASSRLS role → `npm run db:migrate` → full `npx vitest run`. Env primes `TEST_DB_WIPE=1` + `DATABASE_URL` ending in `_test` so the isolation suite's double safety gate unlocks.
- **Pre-existing lint backlog**: `npm run lint` surfaces 194 errors + 970 warnings (mostly `no-explicit-any` + unused-vars). None from the new code. Lint step is `continue-on-error: true` so PR / main checks aren't blocked by the historical backlog. Tracked in §4 backlog "Cleanup pre-existing lint errors" — once empty, remove the `continue-on-error` line and let lint be a real gate.
- **Manual follow-up**: enable branch protection on `main` requiring the PR workflow green before merge — that's a repo-settings click and is documented in `README.md` "Tests" section.

### 2026-06-03 — H04 (/healthz + /readyz) and H10 (per-email pwd reset throttle)

- **H04** — two App Router routes under `app/healthz/` and `app/readyz/`. `/healthz` is a no-deps static 200 with `{ status, uptime, version }`. `/readyz` races a Postgres `SELECT 1` and Redis `PING` against a 1 s timeout each; reports `db`/`redis` status per component and returns 503 if either required component fails. Redis-disabled (no `REDIS_URL` or `CACHE_DISABLED=1`) is reported as `"disabled"` and stays 200 because cache is opportunistic by design. Both paths added to `middleware.ts` `PUBLIC_PATHS` so they bypass the auth gate. Sentry server + edge configs switched from `tracesSampleRate` to `tracesSampler` so probe traffic returns 0 sample rate. `infra/nginx.conf.example` got `location =` blocks with `access_log off` for both. Smoke: `/healthz` → `{"status":"ok","uptime":2799,"version":"0.1.0"}`, `/readyz` → `{"status":"ready","db":"ok","redis":"ok"}`.
- **H10** — new `pwd.forgot.email` rate-limit bucket (3 / 1 hr, identifier = `sha256(email_lower)`). Consumed BEFORE the DB lookup in `app/api/account/password/forgot/route.ts` so timing is identical for known + unknown emails; consumed unconditionally so attempt count never leaks email existence. Hashing keeps raw emails out of Redis keys. New `tests/ratelimit.test.ts` (3 tests, all green) verifies the 3-then-block budget and per-hash isolation; mirrors the cache test's Redis-availability gating. Bucket added to the §1.5 rate-limit catalog.

### 2026-06-03 — Launch-readiness specs split + H01 restore drill executed

- **Launch-readiness specs (§7)**: cut the launch backlog into three buckets with concrete acceptance criteria. Hard specs (H01-H12) — in-repo work that must ship before paid launch. Soft specs (S1-S16) — trigger-based, deferred until a real user signal. External specs (E1-E7) — gated on outside parties (hosting, vendor, Paymob, SMS provider, ETA, Meta, mobile companion app). Per-spec files live under `specs/hard/` with status, acceptance checkboxes, implementation plan, and verification log. Index at `specs/README.md`.
- **H01 — Restore drill executed.** Closed §5's "Restore drill never run" gap. Latest daily dump (`daily-2026-06-01T02-30-00Z.sql.gz`, 31 KB) restored against a throwaway `postgres:16-alpine` container on port 55432 in 1 s wall time. Row counts match source within expected delta (one `activity_logs` row written between dump time and capture). RLS preserved: `relforcerowsecurity = t` on all sampled tables, and a behavioural test as a NOSUPERUSER NOBYPASSRLS role confirmed 0 rows without `app.tenant_id` and tenant-scoped reads with it. Full log: `infra/drills/restore-drill-2026-06-03.log`.
- **Restore-drill follow-up surfaced (not a launch blocker):** `pg_dump --no-privileges` strips GRANTs, so after a production restore `matgary_app` must be recreated + regranted on every tenant-scoped table. `infra/init-postgres.sql` only covers the fresh-container path. Production restore runbook needs both steps spelled out — added to `specs/hard/H01-restore-drill.md` follow-ups; not blocking launch because today's restore would be operator-initiated.

### 2026-05-12 — WhatsApp Phase 7 (inbox UI shell)

The operator-facing surface for conversations. Six previous phases of plumbing are now visible at `/whatsapp`. Layout is responsive: two-pane on desktop, stacked on mobile.

- **Page** (`app/whatsapp/page.tsx`): permission-gated on `manage_whatsapp`. The active conversation lives in `?c=<id>` so refresh / browser-back / shareable URLs all work. Mobile shows list OR thread, never both; desktop shows them side-by-side on a `md:grid-cols-[340px_1fr]` grid. Height pinned at `100dvh - 9rem` so the thread fills the viewport instead of pushing the footer.

- **ConversationList** (`components/whatsapp/ConversationList.tsx`): paginated fetch with cursor (`?before=<iso>`). Tabs: All / Unread / Archived. Auto-polls every 10s for new previews + unread counts. A `refreshSignal` prop is bumped by the parent whenever the thread acts (send, archive, mark-read), so the list re-fetches immediately rather than waiting for its own tick. "Load more" button appears when `nextBefore` is present. Last-message preview prefixed with "أنت:" when the last message was outbound.

- **ThreadView** (`components/whatsapp/ThreadView.tsx`):
  - Header: contact display name (falls back to phone) + LTR-rendered international phone + an Archive/Restore toggle.
  - Window-state banner under the header, coloured per `windowDisplay()` — green when open, orange in the last hour, grey when closed. Closed-window banner replaces the composer with a hint linking to /settings for template management.
  - Messages paginated reverse-chrono. "Load older" button at the top when there's more history. Auto-scrolls to bottom on initial load and on new-message growth, but NOT when older history is prepended (initial-load ref guard).
  - Auto-marks-read once on open (`PATCH /api/whatsapp/conversations/[id] { read: true }`); failure is harmless.
  - Composer is a textarea — Enter sends, Shift+Enter newlines. Sends via `/api/whatsapp/cloud/send`. After a successful send, immediately re-fetches the thread + conversation so the queued message shows up instantly.
  - Polls thread + conversation summary every 8s.
  - `useImperativeHandle` exposes a `refresh()` so the page can force a re-poll from outside (reserved for future SSE-bridge work).

- **MessageBubble** (`components/whatsapp/MessageBubble.tsx`): WhatsApp-style bubbles — outbound accent-coloured + right-aligned, inbound bg-main + left-aligned. Non-text content gets a bracketed label (`[صورة]`, `[مستند]`, etc.). Outbound status icons: clock (queued) / single tick (sent) / double tick (delivered) / blue double tick (read) / alert (failed). Failed bubbles render the `failureReason` inline so the operator understands why a send didn't land.

- **Sidebar nav**: new `WhatsApp` entry under secondary items, gated on the same `manage_whatsapp` permission. Icon `MessageCircle` (Phosphor `ChatCircle` via the existing icon shim).

**Why URL-state for the active conversation:**
- Lets the operator share a link directly to a thread (e.g. for support handoffs). Browser back/forward also works as expected — no in-memory-only navigation traps.

**Why polling instead of SSE for v1:**
- The notifications stream lives at `/api/notifications/stream` and is already wired for that domain. Bolting WhatsApp events onto the same stream is the right shape (Phase 8 work) but means cross-cutting changes; polling is good enough at the cadences chosen (10s list / 8s thread) and degrades gracefully under load.

**Why no template picker in the closed-window state yet:**
- Each template has a different parameter shape; a generic in-thread picker would need a per-template parameter form. We surface the hint + link to /settings where the receipt template can be configured, which handles the highest-value freeform-blocked case.

**Carry-forward into Phase 8+:**
- SSE bridge for live message updates (extend the notifications stream or run a parallel `/api/whatsapp/stream` keyed by tenant+branch).
- In-thread template picker for the closed-window flow.
- Inbound-media download worker (Phase 3 carry-forward) — `media_id` is captured on the inbound row but the blob isn't fetched, so the bubble label `[صورة]` is as deep as it goes today.
- Per-conversation labels/tags UI surface.

### 2026-05-12 — WhatsApp Phase 6 (template webhooks, OTP endpoint, receipt-as-template)

Production-impact phase. The integration now reacts to Meta-side template approvals in real time, ships a hardened OTP endpoint, and lets operators flip the receipt send path from PDF to a Meta-approved utility template — which is the unlock for working *outside* Meta's 24-hour customer-service window for post-purchase receipts.

- **Template status webhook**:
  - `webhook-types.ts` extended: `MetaWebhookChangeValue` gains the `event` / `message_template_id` / `message_template_name` / `message_template_language` / `reason` / `other_info` fields Meta sends on `field='message_template_status_update'`.
  - `extractEvents` adds a branch for the new field. One logical event per change; idempotency key folds in the verb + timestamp so a template that bounces `PENDING → REJECTED → APPROVED` produces three distinct event rows (each preserved). `phone_number_id` is intentionally null — template events route via the WABA fallback in `resolveTenant`.
  - `webhook-processor:handleTemplateStatusUpdate` applies the verb to the cached `wa_templates` row via `applyTemplateStatusUpdate` (new repo method). `reason` lands in `rejected_reason` regardless of which terminal state we hit (overloaded explanation field). Uncached templates log `wa.webhook.template_update.uncached` and ack — no synthetic insert, since Meta's webhook doesn't include the full components blob.

- **OTP endpoint** (`POST /api/whatsapp/otp/send`):
  - Body: `{ phone, code (4-8 digits regex), templateName?, language? }`. Defaults: `otp` / `en_US`.
  - Layered rate limit:
    - **Per-(tenant, branch, phone)**: 5 sends / 15 min — blocks abuse of a single number.
    - **Per-tenant**: 60 sends / hour — caps global fan-out.
  - Wraps `sendOutboundTemplate` with the authentication-template shape: body param `[{ type:'text', text:code }]` plus a `sub_type:'url'` button parameter populated with the same code (harmless when the template lacks a button, populated when it has one — covers both auth-template flavours Meta auto-creates).
  - The caller (signup/login flow on the consumer side) generates and verifies the code; we just deliver. Keeps retention, hashing, and verify semantics in caller control.

- **Receipt-as-template**:
  - Schema: `0024_shop_settings_receipt_template.sql` adds `receipt_template_name` + `receipt_template_language` to `shop_settings`. Both nullable; both empty = legacy PDF path.
  - DTO + repo + API patch schema + client `ShopSettings` type + `DEFAULT_SETTINGS` + `isEqualSettings` all updated.
  - Settings UI: new "قالب الفاتورة (اختياري)" sub-card inside the templates card. Dropdown populated from approved templates filtered to `category in (utility, authentication)`. Documents the fixed 4-parameter contract inline: `{{1}}` customerName, `{{2}}` invoiceCode, `{{3}}` totalPrice, `{{4}}` productNames. Owner-set; empty selection clears both columns at once.
  - `SaleForm`: new `useReceiptTemplate` branch (gated on `useCloud && both columns set`) takes priority over the PDF branch. Sends `POST /api/whatsapp/cloud/send-template` with the 4 body parameters. Falls through to PDF / text / Green API when unconfigured. Restructured the if-chain so the form-reset code at the bottom is still reached after the fire-and-forget send.

**Why a fixed parameter contract instead of mapping UI:**
- 95% of receipt templates need the same four fields. A mapping UI would slow operator onboarding and add a permanently-extra config surface. Tenants whose template needs more or different fields can ship Phase 6.5 with an explicit mapping; for now the contract is documented and minimal.

**Why we don't synthesize a wa_templates row from the webhook:**
- The status-update webhook carries name + language + event but NOT the components blob. Creating a row without components would mean the next send-time lookup returns a usable-looking row that explodes when we try to render. Better to ack and rely on the operator running sync once.

**Carry-forward into Phase 7:**
- Inbox UI shell — the conversation/message APIs from Phase 4 + the template send infrastructure from Phase 5/6 are ready to back a thread view. Open question: realtime updates (SSE vs polling) and whether to colocate with the existing notifications system.
- Per-template parameter mapping UI when the fixed contract gets in the way.
- Daily background template-sync cron (in addition to webhook + manual). Phase 7 nicety.
- Inbound-media download worker. Lower priority — `media_id` is captured but the blob isn't fetched.

### 2026-05-12 — WhatsApp Phase 5 (message templates: cache, sync, send)

Adds the template layer that lets tenants send outbound messages outside Meta's 24-hour customer-service window. Templates are created and approved in Meta Business Manager; our app caches the approved set per branch and the send facade refuses to dispatch non-approved templates.

- **Schema** (`0023_wa_templates.sql`): `wa_templates` table per (tenant, branch, name, language) — `category` (authentication/utility/marketing), `status` (approved/pending/rejected/paused/in_appeal/pending_deletion/disabled/flagged/stale/unknown — `stale` is our addition for templates that disappeared from Meta's response), `components` jsonb (header/body/footer/buttons structure verbatim), `quality_score` + `rejected_reason`, `parameter_format` (POSITIONAL vs NAMED), `last_synced_at`. RLS forced.

- **Meta Graph extension** (`lib/whatsapp/meta-graph.ts:listMessageTemplates`): walks `GET /{waba}/message_templates` with cursor pagination (capped at 40 pages * 100 = 4000 templates per branch). Returns typed `MetaTemplate[]` with all relevant fields.

- **Templates repo** (`lib/whatsapp/templates.ts`):
  - `syncTemplatesForBranch` — owner-triggered full re-sync. Fetches via Graph (with the decrypted token from the active connection), upserts via `(tenant, branch, name, language)` unique index, then marks cached rows not seen in this run as `status='stale'`. Idempotent; safe to re-run.
  - `listTemplates(tenantId, branchId, opts)` — UI listing, filterable by status/category, defaults exclude `stale`.
  - `getApprovedTemplate(name, language)` — send-time lookup, ONLY returns rows with `status='approved'`. Paused/rejected templates can't slip through to a real send.

- **Send pipeline**:
  - `outbound-sender.ts:sendTemplateToMeta` — builds Cloud API `type:'template'` payload with `template.name` + `template.language.code` + `template.components`.
  - `outbound.ts:sendOutboundTemplate` — facade. Validates approved status before persisting any queued row, so a missing/paused/rejected template returns 400 with a clear message instead of failing in the worker. Bypasses the 24h window (that's the whole point of templates). Preview text is taken from the body component when available, else `[template:<name>]`.
  - `queue.ts` — new `outbound.template` job kind + `OutboundTemplateJobData`. Same retry policy and `jobId` (`outtpl:<clientMessageId>`) dedupe as the other outbound kinds.
  - `jobs.ts:handleOutboundTemplate` — symmetric to the text/document handlers; patches `wa_messages` regardless of outcome before deciding whether to retry.

- **API routes**:
  - `GET /api/whatsapp/templates?status=&category=&includeStale=1` — paginated cached list.
  - `POST /api/whatsapp/templates/sync` — owner-only re-sync. Rate-limited 6 / 5 min per branch.
  - `POST /api/whatsapp/cloud/send-template` — body `{ phone, templateName, language, components[] }`. Returns the standard `{ ok, clientMessageId, status, idMessage? }` shape; pollable via the existing `/api/whatsapp/messages/[clientMessageId]` endpoint.

- **Settings UI**: new card under the WhatsApp section, visible only when an active OAuth connection exists. Lists templates with name/language/category badges + colored status pill (`approved` green / `pending` orange / `rejected` red / `stale` grey). "مزامنة من Meta" button is owner-gated. Rejected templates surface the `rejected_reason` inline. Max-height with scroll so 100+ templates don't blow up the page.

**Why we don't *submit* templates from the app:**
- Meta requires the create flow to be done in Business Manager so the operator can preview, supply examples for parameters, and route to the right Business Account. The submission flow is also more strict than the list flow (requires the WABA owner role). Phase 6+ may add it once tenants ask, but caching + sending is the higher-leverage build right now.

**Why `status='stale'` instead of deleting absent rows:**
- A "template I had yesterday is gone today" event is forensically interesting (likely a manual delete in Business Manager, possibly an audit signal). Soft-marking keeps the cached row + last_synced_at for the operator to see, and the send-time lookup filters them out anyway.

**Why approve-check at facade time (not just at worker time):**
- The HTTP caller (or the SaleForm Phase-6 code) gets immediate feedback. Without it, a tenant who deletes a template would still see queued rows pile up before each one fails in the worker — bad UX and noisy retries.

**Known gaps going into Phase 6:**
- `message_template_status_update` webhook isn't handled yet. Approval-state changes only land via manual sync; Phase 6 will hook the webhook so `paused`/`rejected` updates appear in real time.
- Receipt-as-template migration: `SaleForm` still uses `cloud/send-pdf`. Phase 6 will route receipts through a configurable utility template (e.g. `receipt_v1`) so post-purchase sends work outside the 24h window. The infra is ready; needs UI + tenant-side template setup.
- OTP convenience endpoint deferred — once tenants approve an authentication template, `POST /api/whatsapp/otp/send` will wrap `sendOutboundTemplate` with rate-limit + numeric-code generation.
- No template-creation UI. Operators create templates in Business Manager (the documented Meta path).

### 2026-05-12 — WhatsApp Phase 4 (conversations + contacts + 24h window awareness)

The missing aggregate layer between individual `wa_messages` and the future inbox UI. Every message now updates a per-contact conversation row; the 24-hour Meta customer-service window is tracked and checkable; the inbox read API is in place.

- **Schema** (`0022_wa_conversations_and_contacts.sql`):
  - `wa_contacts` — one row per (tenant, branch, phone). `display_name` from Meta `contacts[].profile.name`, `merchant_label` owner-editable (takes precedence), `tags` reserved for future segmentation. Unique on (tenant, branch, phone). RLS forced.
  - `wa_conversations` — one row per (tenant, branch, contact). Aggregates `last_message_at` / `last_message_preview` / `last_message_direction` / `unread_count` / `window_expires_at` / `archived_at` plus the latest conversation_id + category snapshot from Meta status webhooks. Unique on (tenant, branch, contact). RLS forced. Partial index on `unread_count > 0` for the inbox unread badge.
  - `wa_messages.conversation_row_id` — new FK back to the aggregate, populated on new writes; nullable so Phase 2-3 historicals don't break (Phase 5 backfill job).

- **Repos**:
  - `lib/whatsapp/contacts.ts:upsertContact` — idempotent; only fills `display_name` when empty so merchant edits never get clobbered by stale webhooks.
  - `lib/whatsapp/conversations.ts` — `ensureConversation` (lazy create), `touchInbound` (extends 24h window via `lastInbound + CUSTOMER_WINDOW_MS`, bumps unread, atomic SQL increment for concurrent writes), `touchOutbound` (preview + last_message_at; does NOT reset window — Meta's rule), `getWindowState`, `listConversations` (paginated by `last_message_at` desc, with `unreadOnly` + `includeArchived`), `getConversationById`, `listMessages`, `markRead`, `setArchived`, `linkMessageToConversation`.
  - Both `touchInbound`/`touchOutbound` are best-effort — caller (webhook processor / outbound facade) never fails if conversation maintenance fails.

- **Auto-maintenance hooks**:
  - `upsertInboundMessage` now extracts `contactDisplayName` from `payload.contacts[0].profile.name` (added a field to its input type), calls `touchInbound`, and links the new message row to the conversation.
  - `recordOutboundQueued` calls `touchOutbound` and links the row.
  - Inbound/outbound previews fall back to `"[image]"` / `"[document]"` / etc. labels for non-text content so the inbox list isn't blank.

- **24-hour window helper** (`lib/whatsapp/window.ts`): `checkSendWindow(tenant, branch, phone)` returns `{ allowed, reason, expiresAt }`. Reasons: `open` / `closed_expired` / `closed_never_contacted`. `explainClosedWindow` renders the human copy. Wired into the outbound facade behind an opt-in `enforceWindow: true` flag — OFF by default this phase so receipt sends still work; Phase 5 flips it ON once utility-template sending lands.

- **Read API**:
  - `GET /api/whatsapp/conversations` — paginated list. Query: `before=<iso>&limit=<n>&unread=1&includeArchived=1`. Returns `nextBefore` cursor.
  - `GET /api/whatsapp/conversations/[id]` — single, with `windowOpen` boolean computed at read time.
  - `GET /api/whatsapp/conversations/[id]/messages` — reverse-chrono page on `created_at`.
  - `PATCH /api/whatsapp/conversations/[id]` — body `{ read?, archived? }`. Archive is owner-only.

**Why a separate `wa_contacts` table (instead of denormalising onto `wa_conversations`):**
- The contact identity is per (tenant, branch, phone) and survives across conversations (e.g. if we ever delete + recreate a conversation). Owner-set `merchant_label` lives there independent of any single conversation row. Cleaner aggregate boundary; one extra join in list queries is cheap.

**Why `touchInbound` increments unread via raw SQL:**
- Two concurrent inbound messages racing on the same conversation row would lose increments under a read-then-write pattern. `unreadCount = unreadCount + 1` in SQL is atomic at the row level.

**Why window enforcement is opt-in:**
- The receipt path in `SaleForm` sends to customers who often haven't messaged us first — flipping enforcement on now would block every receipt. Phase 5 will swap that path to a pre-approved utility template (`receipt_v1` or similar) which can send outside the window, and only *then* flip `enforceWindow` to true for any remaining freeform paths.

**Known gaps going into Phase 5:**
- `wa_messages.conversation_row_id` isn't backfilled for pre-Phase-4 rows. Historical messages won't appear in the conversation thread view until we run a one-shot backfill (cheap; one `UPDATE … FROM wa_conversations` is enough).
- Inbox UI shell hasn't been built — these API routes are in place but no React component consumes them yet.
- Message templates not implemented. Phase 5 brings template sync + the receipt path migration.
- No realtime push to the inbox (long-poll/SSE) yet. The settings page polls `/api/whatsapp/connection` already; conversations can do the same with a 5s tick when an inbox shell lands.

### 2026-05-12 — WhatsApp Phase 3 (BullMQ outbound queue, inbound enqueue, retry policy, replay)

Reliability layer: every WhatsApp send and every webhook event now flows through BullMQ when Redis is available, with retry semantics, dead-letter, and graceful inline fallback when not. The send routes return immediately with a client message id; the worker drives the Graph round-trip in the background and patches the row when Meta responds.

- **Queue infra** (`lib/whatsapp/queue.ts`): single named queue `wa-jobs`, four typed job kinds (`outbound.text`, `outbound.document`, `inbound.process`, `quarantine.replay`). Dedicated ioredis connection (`maxRetriesPerRequest: null`, `enableReadyCheck: false`, `lazyConnect: true`) because BullMQ's blocking commands are incompatible with the cache client's retry config. Singletons attached to `globalThis` so Next dev hot-reload doesn't pile up workers. `getQueue()` / `isQueueEnabled()` / `enqueue*` helpers — all return `null` when `REDIS_URL` is unset, callers fall through to inline execution.

- **Worker bootstrap** (`instrumentation.ts`): Next 16's per-server-boot hook. On Node runtime + `REDIS_URL` set, spawns one in-process `Worker(QUEUE_NAME, routeJob)` with `concurrency: 10`, `lockDuration: 60_000`. Idempotent SIGTERM/SIGINT handlers (name-matched on `process.listeners` so hot-reload doesn't duplicate) call `closeQueueInfra()` to drain in-flight jobs before exit.

- **Outbound facade** (`lib/whatsapp/outbound.ts`): single entry point `sendOutboundText` / `sendOutboundDocument`. Flow: validate phone → resolve credentials → `randomUUID()` clientMessageId → `recordOutboundQueued` (wa_messages row, `status='queued'`) → enqueue or inline. Pre-flight credential check avoids creating queued rows for tenants who can't send. Always returns `{ ok, clientMessageId, status, rowId, metaStatus, idMessage? }` — `status` is `'queued'` after enqueue, `'sent'`/`'failed'` after inline.

- **Shared sender** (`lib/whatsapp/outbound-sender.ts`): the actual Graph round-trip extracted from the old send routes. Reused by both the inline path and the worker. PDF mode is a three-step dance (generate PDF → upload to `/media` → send document referencing media_id). Returns a structured `SendOutcome { ok, metaMessageId, errorMessage, errorCode, status }` plus `isRetryableSendError(outcome)` classifier — 429 + 5xx + network errors + Meta error codes 1/2/4 retry; 4xx terminate.

- **Job router** (`lib/whatsapp/jobs.ts:routeJob`): switch on `job.name` → handler. Each handler patches `wa_messages` BEFORE deciding whether to retry, so even the final attempt's failure leaves a clean terminal state. Throwing from the handler triggers BullMQ retry; not throwing acks the job. Inbound delegate to `processEvent(eventId)` which is itself idempotent + walks the state machine added in Phase 2. Quarantine replay re-resolves tenant against current connections and flips status `quarantined → pending` before re-processing.

- **Send routes refactored** (`/api/whatsapp/cloud/send` + `/send-pdf`): now ~50 lines each. Validation → rate-limit → `sendOutboundText`/`sendOutboundDocument` → response. Response carries `clientMessageId` + `status` always, plus `idMessage` when the inline path completed in-band.

- **Webhook enqueue** (`/api/whatsapp/webhook` POST): replaced `setImmediate(processEvent)` with `enqueueInboundProcess({ eventId })` when the queue is enabled. Falls back to `setImmediate` when Redis is off so a minimal-infra deploy still works. Enqueue failures log + continue — the event row is already `pending` in the DB and any future worker run can pick it up via the partial index `wa_webhook_events_pending_idx`.

- **Status polling** (`GET /api/whatsapp/messages/[clientMessageId]`): tenant-scoped (RLS-enforced) status read. Returns the wa_messages row keyed by the clientMessageId minted at queue time. Lets the settings test-send UI poll for the eventual WAMID + sent/delivered/read timestamps once status webhooks arrive.

- **Quarantine replay** (`POST /api/whatsapp/webhook/events/[id]/replay`): owner-only. Re-runs tenant resolution. If the row is no longer quarantined (raced), returns 400. If still unrouted after re-resolution, returns ok=false with a clear note. Otherwise rewrites routing columns + processes inline (or enqueues via `quarantine.replay` when the queue is on).

- **Messages repo** (`lib/whatsapp/messages.ts`):
  - `recordOutboundQueued` — pre-existing, now actually called.
  - `patchOutboundOnSendResult` — new; flips `queued → sent` (with WAMID) or `queued → failed` (with reason + Meta code). Does **not** overwrite the *_at columns that the status webhook will fill in later (delivered/read), so the lifecycle stays append-only.
  - `getMessageByClientId` — tenant-scoped lookup for the status polling endpoint.

**Why one queue, not many:**
- Single queue simplifies dashboards, monitoring (Bull Board / arena point at one key), and the worker lifecycle. Job priorities and per-name concurrency limits are a Phase 4+ concern.

**Why inline fallback when Redis is unavailable:**
- A self-hosted POS without Redis still needs WhatsApp to work — the cache + rate-limit already follow this pattern. Inline execution loses retries but not correctness; `wa_messages` is still durable.

**Why `randomUUID` at the API layer (not in the queue):**
- The clientMessageId is the *external* identifier that callers see in the response and use to poll. Generating it at the API ensures the row exists before the queue even sees the job, so a failed enqueue still leaves a queryable record.

**Known gaps going into Phase 4+:**
- Bull Board / arena UI isn't wired — admins inspect failed jobs via Redis CLI or extend `/api/whatsapp/webhook/events` for the queue side too.
- The worker is co-located with the HTTP server. Multi-instance HTTP would mean each instance runs a worker — fine for moderate volume (BullMQ leases jobs cleanly) but a dedicated worker container is the real long-term shape.
- SaleForm still uses `fetch("/api/whatsapp/cloud/send-pdf")` directly. The contract change (response carries `clientMessageId` + `status` instead of just `idMessage`) is back-compat because we still emit `idMessage` when the inline path runs; the `console.log` lines will say `"queued"` instead of a WAMID when async, but no UX breakage.
- Media download for *inbound* media messages (`media_id` field on inbound rows) still isn't wired. A `media.download` job kind can slot in once we choose blob storage.
- Template approval/sync, OTP flows, and the inbox UI remain Phase 4+. The queue + persisted message + lifecycle layer here is the foundation they'll plug into.

### 2026-05-12 — WhatsApp Phase 2 (webhooks: signature, persistence, tenant routing, status lifecycle)

The receive-side of the integration: Meta now has a verified webhook endpoint, every delivery is signature-checked, dedup'd, persisted before processing, and routed to the right tenant by phone_number_id. Inbound customer messages and outbound status transitions land in `wa_messages` with the full lifecycle.

- **Schema** (`0021_wa_webhook_events_and_messages.sql`):
  - `wa_webhook_events` — internal audit log of every webhook delivery. Columns: `provider_event_id` (idempotency key with provider), `event_type` (`message.received` / `message.status` / `unknown`), nullable `tenant_id` / `branch_id` / `connection_id` (NULL = quarantined because routing failed), preserved `phone_number_id` + `waba_id`, `payload jsonb` (the slice we processed — single message or single status, not the whole batch), processing-state machine (`pending` / `processing` / `processed` / `failed` / `quarantined` / `dead_letter`) plus `retry_count`, `last_attempt_at`, `next_attempt_at`, `error_details`. Unique index on `(provider, provider_event_id)` enforces idempotency; partial index over `(processing_status, next_attempt_at) WHERE status IN ('pending', 'failed')` is the hot path for the future worker. **No RLS** on this table — quarantine rows have no tenant by definition, and the admin inspection endpoint filters at the SQL level.
  - `wa_messages` — normalised inbound + outbound messages, tenant-scoped, RLS forced. `meta_message_id` (WAMID) is unique within (provider) via partial index; `client_message_id` is unique within tenant for Phase-3 queue correlation. Content fields (`text_body`, `media_id`, `media_mime_type`, `media_filename`, `media_sha256`, full `payload jsonb`), full status lifecycle (`queued`/`sent`/`delivered`/`read`/`failed`) with per-state timestamp columns, failure reason + Meta code, and conversation/pricing metadata for future cost-attribution analytics.

- **Signature verification** (`lib/whatsapp/webhook-signature.ts`): timing-safe HMAC-SHA256 against `META_APP_SECRET`. Rejects all of `missing_secret`, `missing_header`, `malformed_header` (wrong prefix or non-hex), `length_mismatch`, `digest_mismatch` with a discriminated reason for the structured logger. Verification runs against the **raw request body** (`req.text()` called before any `JSON.parse`); invalid signatures return 401 before parsing.

- **Webhook receiver** (`app/api/whatsapp/webhook/route.ts`):
  - `GET` — Meta subscription challenge. Compares `hub.verify_token` against `WHATSAPP_WEBHOOK_VERIFY_TOKEN`; echoes `hub.challenge` only on match. 403 otherwise; 500 if env var unset.
  - `POST` — raw body → signature → JSON parse → extract per-message/per-status events → persist each idempotently → ACK 200 → `setImmediate` background processing. ACK is fast even on batches: persistence is one upsert per event, processing happens after the response is sent. Phase 3 will swap `setImmediate` for BullMQ — `processEvent(id)` already has a queue-friendly signature.
  - `export const dynamic = "force-dynamic"` so Next 16 doesn't try to cache the route.

- **Event extraction** (`lib/whatsapp/webhook-events.ts:extractEvents`): walks Meta's nested envelope and yields one `ExtractedEvent` per message / per status. Idempotency keys:
  - `msg:<wamid>` for inbound messages
  - `status:<wamid>:<state>` for status transitions (sent/delivered/read each get distinct rows so we never collapse a lifecycle)
  - `change:<sha1>` for `errors[]` blocks or change kinds we don't yet decode (rare but persisted for forensics)

- **Tenant resolution** (`lib/whatsapp/webhook-processor.ts:resolveTenant`):
  1. Primary: `wa_connections` lookup by `phone_number_id` (globally unique on Meta's side, enforced by our own unique index).
  2. Fallback: `wa_connections` lookup by `waba_id` filtered to `status='active'` (most-recently connected wins).
  3. Neither resolves → event is persisted with `tenant_id=NULL`, `processing_status='quarantined'`, and `error_details` captures the unrouted IDs. Logged as `wa.webhook.quarantined`. Never silently dropped.

- **Processor** (`lib/whatsapp/webhook-processor.ts:processEvent`): re-fetches the row by id, walks the state machine, dispatches by `event_type`. Inbound → `upsertInboundMessage` (idempotent on WAMID; never overwrites bodies). Status → `applyStatusUpdate` (per-state timestamps appended; failure code/reason captured; conversation + pricing metadata extracted; if no matching outbound row exists yet — possible when the queue is added — creates a placeholder with `direction='outbound'`). `RetryableError` advances `retry_count` and schedules backoff (`60s * 2^attempt`, capped at 1h). `TerminalError` flips to `dead_letter`. Anything else is treated as retryable.

- **Connections lookup hardening** (`lib/whatsapp/connections.ts:getActiveConnectionByWabaId`): added for the fallback resolution path. Uses raw `db` because the webhook handler runs outside any tenant session.

- **Admin inspection** (`GET /api/whatsapp/webhook/events?status=...&scope=...&limit=...`): owner-only. Two scopes:
  - `scope=tenant` (default) — caller's own tenant_id only.
  - `scope=quarantine` — rows with `tenant_id IS NULL`. Owners can see these because by definition they belong to nobody; renders payloads truncated to ~1KB per top-level value so a runaway webhook can't blow up the response.

- **Structured logging** events added to the namespace:
  - `webhook.verify.ok`, `webhook.verify.rejected`, `webhook.verify.misconfigured`
  - `webhook.signature.invalid` (with discriminated `reason`)
  - `webhook.receive.ok`, `webhook.receive.body_read_failed`, `webhook.receive.json_parse_failed`, `webhook.receive.persist_failed`
  - `wa.webhook.routed`, `wa.webhook.quarantined`, `wa.webhook.dedup`
  - `wa.webhook.process.ok`, `wa.webhook.process.noop`, `wa.webhook.process.missing_row`
  - `wa.webhook.retry_scheduled`, `wa.webhook.deadletter`
  - `webhook.process.unhandled` (caught at the setImmediate boundary so worker errors never escape silently)

- **Env** (`.env.example`): `WHATSAPP_WEBHOOK_VERIFY_TOKEN` upgraded from "Phase 2" to "REQUIRED once a webhook URL is registered" with the matching Meta-dashboard field documented.

**Why no BullMQ yet:**
- The processing path is already queue-shaped (`processEvent(eventId)` is the unit of work). Phase 3 replaces `setImmediate` with a queue producer and adds the worker loop. The DB schema is the durability boundary — events are safe before any worker exists.

**Why mark inbound payloads idempotent on `meta_message_id` instead of inserting always:**
- Meta retries unacknowledged webhooks every few seconds for ~24h. Without per-WAMID uniqueness we'd accumulate duplicate inbound rows. The unique index on `(provider, meta_message_id) WHERE meta_message_id IS NOT NULL` collapses retries to a single row regardless of how many times the webhook fires.

**Why classify status transitions as separate events:**
- A single outbound message goes through `sent` → `delivered` → `read` (or → `failed`) on three distinct webhook deliveries. Treating them as one logical event would mean we'd dedup the *transition* against the previous one and lose the timeline. Each `(WAMID, state)` is its own event row; the WAMID row in `wa_messages` accumulates the per-state timestamps.

**Known gaps going into Phase 3:**
- Worker is in-process via `setImmediate`. Single-instance deploy is fine; multi-instance will need BullMQ + lock semantics on the event row before processing.
- Quarantined events don't auto-replay when a connection is restored. The admin endpoint exposes them; manual re-process endpoint is a Phase 3 nicety.
- Outbound `SaleForm` send path still uses fetch-and-forget — once a 'sent' status arrives the row materialises in `wa_messages` retroactively. Phase 3 will move sending to a queue and pre-create the outbound row at queue time with `client_message_id`.
- Media download from `media_id` isn't wired yet — the id is captured on inbound rows but Phase 3 will add the Graph fetch + storage step.

### 2026-05-12 — WhatsApp Embedded Signup Phase 1.5 (health check + structured logging + multi-tab safety)

Polish pass on top of Phase 1 before the Phase-2 webhook work lands. Three discrete additions; nothing existing changed semantically.

- **Token metadata** (`0020_wa_connections_health.sql`): three new columns — `token_last_validated_at` (only moves on successful `/debug_token`), `last_graph_healthcheck_at` (bumped every run regardless of outcome — drives UI throttling), `connection_error_state` (machine-readable code: `ok`/`token_expired`/`token_revoked`/`scope_missing`/`waba_inaccessible`/`phone_unverified`/`network`/`unknown`). All nullable; existing rows show as "never checked" until the first run.
- **Health-check service** (`lib/whatsapp/health.ts` + `POST /api/whatsapp/connection/healthcheck`): runs `/debug_token` → `listPhoneNumbersForWaba` → `getBusinessForWaba`, classifies Meta OAuthException codes/subcodes into the state enum (190+458 → revoked; 190+463 → expired; 401/403 → revoked; 5xx → network), persists outcome via `recordHealthcheck`, and returns the actionable diagnostic (note + needsReauth) to the UI. Rate-limited 4/30s per (tenant, branch). When the check decides the token is unusable it also flips `status` to `revoked`/`expired` so send routes refuse fast without an extra Graph hop.
- **Structured logger** (`lib/logger.ts`): single-line JSON in production (`NODE_ENV=production` or `LOG_FORMAT=json`), compact human format in dev. Stable event-name namespace — `wa.oauth.start`, `wa.oauth.connected`, `wa.oauth.csrf_mismatch`, `wa.oauth.invalid_state`, `wa.oauth.code_exchange_failed`, `wa.oauth.discovery_failed`, `wa.oauth.subscribe_failed`, `wa.oauth.unsubscribe_failed`, `wa.oauth.persist_failed`, `wa.oauth.multi_waba_granted`, `wa.oauth.debug_token_failed`, `wa.oauth.disconnected`, `wa.oauth.start.not_configured`, `wa.oauth.extend_token_failed`, `wa.healthcheck.completed`, `wa.graph.ok`, `wa.graph.error`. `SENSITIVE_KEYS` redacts `accessToken`/`access_token`/`token`/`appSecret`/`secret`/`Authorization`/`rawMetadata` at any nesting depth; phone numbers are still emitted but only the IDs (Phase 2 will trim inbound user numbers to last-4). Wired through `meta-graph.ts` HTTP helper and every OAuth route.
- **Multi-tab CSRF hardening** (`lib/whatsapp/oauth-state.ts`): per-flow cookie names — each Connect click mints a `flowId` (4 random bytes hex) embedded in both the signed state payload and the cookie name (`mg.wa_oauth_state.<flowId>`). Two tabs starting Connect now get distinct cookies instead of clobbering each other. Callback parses `flowId` out of the state HMAC *first*, then verifies the cookie at the matching name — so flowId mismatch and cookie-name mismatch are the same failure mode. State TTL stays 15min; cookie is cleared on every callback exit path regardless of success.
- **Reconnect/re-auth UX**: settings page reads `connectionErrorState` from the connection endpoint and renders an inline orange banner with a state-specific CTA — "Reconnect now" for `token_expired`/`token_revoked`/`scope_missing`/`waba_inaccessible`, "Retry" for `network`, and free-form copy from the health-check `note` field for `phone_unverified`. Added a permanent "فحص الاتصال" button next to Reconnect/Disconnect.
- **Developer setup doc** (`docs/whatsapp-onboarding.md`): step-by-step Meta App creation, Facebook Login for Business configuration, redirect-URL whitelist, scopes + App Review notes, local ngrok/cloudflared, env-var table, common OAuth failure modes, log-event reference, and a production checklist.

**Why per-flow cookies (instead of moving state into Redis):**
- Cookies are already free; adding a Redis-backed session for this would mean a network hop on every callback for marginal benefit. The cookie *is* the binding evidence — moving it server-side just trades one trust assumption (cookie integrity) for another (session-store lookup correctness). HMAC + per-flow naming gets the same anti-CSRF property without the infra.

**Why classify Meta error codes manually:**
- Meta documents `error_subcode` better than they document the parent code's meaning, and the subcodes are stable enough that string-matching `err.message` would be fragile. The classifier in `lib/whatsapp/health.ts:classifyError` is a small switch — adding a new subcode means one line, not a migration.

**Known gaps still open going into Phase 2:**
- Health-check runs only on demand (manual button). Phase 3 will schedule it via BullMQ; the rate-limit + persistence is ready for that consumer.
- `tokenLastValidatedAt` is set but not yet visible in the UI — Phase 2 polish will surface "validated X ago".
- `phone_unverified` doesn't yet open a deep link to Meta Business Manager. Phase 2 will add a "Verify in Business Manager →" link when the state hits.

### 2026-05-12 — WhatsApp Embedded Signup Phase 1 (OAuth onboarding + connection storage)

First step toward a full BSP-grade integration: store owners can connect their own WhatsApp Business Account via Meta's Login for Business flow without copying tokens by hand. Green API and the manual Cloud-API fields stay in place as fallbacks during the App Review window.

- **Schema** (`0019_wa_connections.sql`): new `wa_connections` table, one row per (tenant, branch, phone_number_id). Stores `waba_id`, `phone_number_id`, `business_id`, `display_phone_number`, `verified_name`, encrypted `access_token` (`v1:iv:ct:tag` via `lib/crypto`), `token_type` ∈ {`user`,`long_lived`,`system_user`}, optional `token_expires_at`, granted `scopes`, `status` ∈ {`active`,`disconnected`,`expired`,`revoked`,`error`}, `mode` ∈ {`sandbox`,`live`}, `webhook_subscribed`, raw Graph response in `raw_metadata` jsonb for debugging. Provider field defaults to `meta_cloud` so future SMS-fallback providers don't need another schema migration. Unique index on `phone_number_id` (it's globally unique on Meta's side and the routing key for inbound webhooks); RLS forced with the same NULLIF guard as `shop_settings`.
- **Meta Graph client** (`lib/whatsapp/meta-graph.ts`): typed module with `exchangeCode`, `extendToken`, `debugToken`, `listWabasForToken`, `listPhoneNumbersForWaba`, `getBusinessForWaba`, `subscribeAppToWaba`, `unsubscribeAppFromWaba`. Centralised error normalisation (`MetaGraphError`), Graph version pinned via `META_GRAPH_VERSION` (defaults `v21.0`). Tokens are never logged — only the path, HTTP status, and Meta error code make it to `console.warn`.
- **Connections repo** (`lib/whatsapp/connections.ts`): tenant-scoped reads (`getActiveConnection`, `getActiveConnectionToken`) that go through `withTenant` + RLS, plus a deliberate `getConnectionByPhoneNumberId` that uses the raw `db` handle (needed by Phase-2 webhooks to resolve the owning tenant *before* opening a session). `upsertConnection` enforces the "one active per (tenant, branch)" invariant and steals a `phone_number_id` if it previously belonged to a different tenant (number-porting / sandbox-to-prod cutover).
- **OAuth flow**: `GET /api/whatsapp/oauth/start` mints an HMAC-signed state token bound to (tenantId, branchId, userId, nonce, iat=now), stores it as an httpOnly cookie, and 302s to Meta's OAuth dialog with the `config_id` from `META_CONFIG_ID`. `GET /api/whatsapp/oauth/callback` verifies the state matches both the HMAC and the cookie, exchanges code → short-lived → long-lived token, walks `/me/businesses → owned/client WhatsApp business accounts` to discover the WABA, lists phone numbers, fetches the owning business, calls `POST /{waba}/subscribed_apps` to register our webhook, calls `/debug_token` to record granted scopes + decide `sandbox` vs `live`, and persists everything encrypted. `POST /api/whatsapp/oauth/disconnect` best-effort unsubscribes and marks the row disconnected.
- **Credential resolver** (`lib/whatsapp/resolve-credentials.ts`): single chokepoint that send routes go through. Precedence: active OAuth connection → manual `shop_settings.whatsapp_cloud_*` columns. Returns `null` when neither is configured, so `/api/whatsapp/cloud/send` and `/api/whatsapp/cloud/send-pdf` respond 409 with a clear message. Refactored both send routes to call it; no behavioural change for tenants on manual creds.
- **Connection status endpoint** (`GET /api/whatsapp/connection`): metadata-only view the settings UI polls — never returns the token, never returns `raw_metadata`.
- **Settings UI**: new "Connect WhatsApp" panel at the top of the Cloud-API card showing live connection state (active/disconnected, verified name + display phone, WABA/phone-number IDs, sandbox/live badge, webhook-pending badge if subscription failed, connected_at). Buttons for reconnect and disconnect. The manual instructions + Phone Number ID / Access Token / WABA ID fields are now hidden by default once a connection exists; they unfold via "أو ضبط يدوي للتوكن (مؤقت)" or auto-show when the tenant already has manual values saved (so legacy setups aren't stranded). Callback flash params (`?wa=ok` / `?wa=error&wa_detail=…`) get surfaced as toasts and stripped from the URL.
- **Env vars** added to `.env.example` (all commented-out — Meta App isn't registered yet): `META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID`, `META_OAUTH_REDIRECT_URL`, `META_GRAPH_VERSION` (default v21.0), `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (Phase 2), `NEXT_PUBLIC_META_APP_ID` (reserved for future JS-SDK popup variant).
- **State signing** (`lib/whatsapp/oauth-state.ts`): reuses `AUTH_SECRET` to HMAC-SHA256-sign the OAuth state payload (`tenantId/branchId/userId/nonce/iat`); 15-minute TTL; cookie binding rejects mismatch as CSRF regardless of HMAC validity.

**Why this shape (instead of jumping straight to the JS SDK popup):**
- Server-side redirect flow round-trips through the existing session cookie, so we get tenant + branch + user identity for free without exposing the App ID to the browser. The `NEXT_PUBLIC_META_APP_ID` env is reserved for the popup variant later.
- Long-lived token (~60d) is what BSPs actually run on; system-user tokens require the BSP onboarding path which we're not on yet. If `extendToken` fails (e.g. the App didn't grant the right scope yet) we fall back to the short-lived token and store `tokenType='user'` so the settings UI can prompt for reconnect.
- `phone_number_id` uniqueness across the table mirrors Meta's reality. Two tenants can't legitimately hold the same id; if it happens we assume the second one is the latest truth.

**Known gaps / explicit non-goals:**
- The OAuth scopes (`whatsapp_business_management`, `whatsapp_business_messaging`, `business_management`) require Meta App Review before they work for arbitrary tenants. Until approved, the flow only works for users who are admins of the Meta App itself — every other tenant will land back at /settings with an error.
- The callback picks the *first* WABA and *first* phone number when the user grants access to multiple. A chooser UI is a Phase-2 nicety; for now we log a warning so we know when it happens.
- Manual `whatsappCloud*` columns on `shop_settings` are now technically dead-code paths in the OAuth happy case. Kept on purpose during the App Review window — they're the fallback when OAuth isn't approved yet. Phase 4 will deprecate them.
- No webhook handler yet (Phase 2). `webhook_subscribed=true` on the row means we *asked* Meta to subscribe our app; the actual event delivery is wired in the next phase.
- No queue yet (Phase 3). Receipt sending still goes through the synchronous fetch in `SaleForm.tsx`; BullMQ will replace that.

### 2026-05-11 — Receipt customisation (تخصيص الفاتورة)

Receipts were rendering hardcoded "Corner Store" / phone / location constants — invisible to every other tenant. They now read the active branch's settings and expose four owner-tunable knobs.

- **Schema** (`0017_receipt_customisation.sql`): four new `shop_settings` cols, all per-(tenant, branch) so each store sets its own.
  - `receipt_logo_size` text default `'medium'` ∈ {`hidden`,`small`,`medium`,`large`}.
  - `receipt_footer_text` text default `''` (multi-line, ≤500 chars after trim).
  - `receipt_language` text default `'ar'` ∈ {`ar`,`en`,`bilingual`}.
  - `receipt_show_loyalty` boolean default `true`.
- **DTO + API**: extended `ShopSettingsDto` (server) and `ShopSettings` (client) plus `patchSchema` z.enum guards on the language + logo-size enums and 500-char clamp on footer (also strips `\r` for cross-OS round-trip). Defaults match the historic hardcoded layout so existing tenants see no visual change.
- **Labels** (`lib/receipt-strings.ts`): a tiny `RECEIPT_LABELS` dictionary (en/ar pairs for ~12 keys) + an `rl(key, lang)` helper. `bilingual` returns `EN · AR` so each row stays a single physical line.
- **Receipt + InvoiceReceipt** components rewritten:
  - Hardcoded `Corner Store` / `STORE_PHONE` / `STORE_LOCATION_*` constants gone — header pulls `settings.shopName` (uppercased) and `settings.shopPhone`. Empty phone hides the contact line cleanly.
  - Logo `<img>` gets a `receipt-logo--{size}` modifier class; `hidden` skips rendering entirely.
  - Optional `receiptFooterText` rendered in a new `.receipt-footer` block (RTL, monospace, whitespace-pre-wrap so multi-line copy survives).
  - QR payload changed from a hardcoded marketing URL to `INVOICE <id>` (or `tel:<shop>` fallback) so cashiers can scan to pull up the invoice.
  - Loyalty rows added (POINTS REDEEMED, CREDIT APPLIED above total; POINTS EARNED + WALLET BALANCE below total) — only render when `receipt_show_loyalty` AND data is non-zero.
  - **Bug fix found in pass**: the receipt's "TOTAL AMOUNT" was showing the pre-loyalty subtotal. Now uses `paidTotal = total - loyaltyDiscountAmount` so the printed total matches what the customer actually paid.
- **CSS**: added `.receipt-logo--{hidden,small,medium,large}` modifiers (both print + on-screen preview variants) and `.receipt-footer` styling (font-cairo, RTL, whitespace-pre-wrap).
- **Settings UI** ("تخصيص الفاتورة" card): logo-size dropdown, language radio with hint copy ("TOTAL · الإجمالي"), 500-char footer textarea with live char counter, show-loyalty toggle, and a live miniature mockup that re-renders as the owner edits. Mockup is a CSS facsimile (not pixel-perfect — real receipt is monospace 80mm) but conveys order, language, and logo size accurately.

**Trade-offs:**
- Mockup mirrors the receipt structure but uses Tailwind boxes instead of the actual `<Receipt>` component — keeps the preview cheap and avoids needing fake invoice data plumbed through. If the real receipt structure drifts, the preview can mislead.
- `receipt_show_loyalty` only governs the loyalty rows on the *receipt*. Cart preview + customer wallet page always show loyalty (where appropriate). The flag is purely cosmetic.
- Bilingual mode crams `EN · AR` into one cell. On 80mm thermal printers with very long products this could wrap. Tested with the standard label set; long product names already had this risk.
- Footer text is rendered verbatim — no template substitution. Owners that want "thanks {customerName}" can request that as a v2.

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
- ~~**Bulk product import** from Excel/CSV.~~ ✅ Done 2026-05-11. Two-phase server-side flow: upload CSV → preview table (per-row create/update/error tags + per-field error messages) → confirm. SKU upsert (insert when empty/new, update when matched), `attribute_values` column with `key=label;…` syntax, template download endpoint pre-fills the active branch's category keys. Multi-store: imports go to the active branch. **Still owed**: native .xlsx parser (today: "Excel → save as CSV UTF-8"); inter-row variant generation (today: each variant is a separate row with its own SKU).
- ~~**Customer loyalty / store credit** programme.~~ ✅ Done 2026-05-11. Unified wallet (points + EGP credit) per (tenant, branch, phone) with audit log. Per-branch enable + rates in settings. Earn auto on paid sales, redeem at checkout, owner manual grant. **Still owed**: points expiry cron, "refund as credit" toggle in returns flow.
- **Per-branch cash drawer reconciliation** (after multi-branch lands).
- **Staff performance leaderboard improvements**: commissions, targets, bonus calcs.
- ~~**Receipt customisation** beyond message template (logo size, footer copy, language toggle).~~ ✅ Done 2026-05-11. Per-branch (multi-store) settings for `receipt_logo_size` (hidden/small/medium/large), free-form `receipt_footer_text` (≤500 chars, multi-line), `receipt_language` (`ar`/`en`/`bilingual`), and `receipt_show_loyalty` toggle. New "تخصيص الفاتورة" card in /settings with live mockup preview. Receipt + InvoiceReceipt now read shop name/phone from settings instead of hardcoded "Corner Store" constants, label set chosen by language, footer rendered below thank-you, loyalty rows (points redeemed, credit applied, points earned, wallet balance) shown when enabled. Receipt TOTAL now reflects post-loyalty paid amount.

### Infrastructure / ops

- **Cleanup pre-existing lint errors** (194 errors, 970 warnings as of 2026-06-03). Mostly `no-explicit-any` + unused-vars. Today's CI runs lint with `continue-on-error: true` so the noise doesn't gate PRs — once the backlog is empty, remove that line and let lint be a true gate. Track via `npm run lint 2>&1 | grep -E "^✖"` regression test.
- **Leave overlap detection.** Today `submitLeaveRequest` only enforces `startDate <= endDate`. Add a check that rejects (or warns the approver) when the same employee already has a submitted/approved leave overlapping the requested window. Sketch from H06 spec: pure `hasOverlap(existing, candidate)` that treats adjacent dates (end-of-A === start-of-B) as non-overlap and ignores rejected leaves. Wire into the route + add a unit test. Half-day. Tracked in §5 as a known gap.
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
- **No leave-overlap detection.** `submitLeaveRequest` only checks `startDate <= endDate`; the same employee can submit (and an owner can approve) two overlapping leaves with no warning. Discovered during H06 — added to §4 backlog as "Leave overlap detection". Not a launch blocker because the cost is operational (double-counted vacation), not data corruption — but worth landing before scaling staff onboarding.
- **No native mobile app.** Browser POS works on phones but UX is mediocre on small screens, and printer/scanner integration needs native.
- ~~**Notifications polling.**~~ ✅ Resolved 2026-05-09 — SSE stream backed by Redis pub/sub. Polling kept as a fallback when EventSource keeps failing.
- ~~**Recurring expenses don't auto-spawn.**~~ ✅ Resolved 2026-05-09 — `POST /api/cron/recurring-expenses` (bearer-auth, rate-limited) + `cron` sidecar in docker-compose pokes it hourly. Lazy catch-up on `listExpenses` retained as a belt-and-braces second path.
- ~~**Cache tests skip silently if Redis is unreachable.**~~ ✅ Resolved 2026-05-09 — `beforeAll` pings Redis when configured; ping failure throws with the underlying error.
- ~~**Restore drill never run.**~~ ✅ Resolved 2026-06-03 — drill executed against the latest daily dump on a throwaway Postgres container, row counts + RLS preserved end-to-end. Log: `infra/drills/restore-drill-2026-06-03.log`. Follow-up (production restore runbook needs explicit role + regrant steps) tracked in `specs/hard/H01-restore-drill.md`.
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

## 7. Launch-readiness specs

Three buckets:

- **§7.1 Hard** — in-repo code work that must ship before paid launch.
- **§7.2 Soft** — can launch without; ship when a real user signal arrives.
- **§7.3 External** — gated on someone outside the codebase (vendor, account, decision).

Recommended execution order is in §7.4. Each Hard spec has explicit acceptance criteria so "done" is unambiguous. Soft specs only list trigger + rough size. External specs document the in-repo deliverable that's ready to land the moment the blocker clears.

---

### 7.1 Hard specs — must finish before paid launch

#### H1. Restore drill execution
**Why:** Backups exist but the restore path has never run. Untested backup = no backup.
**Acceptance:**
- Spin up throwaway Postgres container (per §1.6 cheatsheet).
- Run `infra/restore.sh` against the latest `backups/*.sql.gz` with `RESTORE_CONFIRM=1`.
- Verify a known tenant's row counts match the source (`SELECT count(*) FROM products WHERE tenant_id = '...'`).
- Append `restore-drill-YYYY-MM-DD.log` to `infra/drills/` with timing + row-count diff.
**Effort:** 30 min.

#### H2. CI pipeline (GitHub Actions)
**Why:** Manual `tsc --noEmit` before push is not a safety net. Money-handling SaaS needs automated gates.
**Acceptance:**
- `.github/workflows/pr.yml` — on every PR: `npm ci`, `npx tsc --noEmit`, `npm run lint`, `npx vitest run tests/cache.test.ts` (Redis service).
- `.github/workflows/main.yml` — on push to `main`: above + full isolation suite against an ephemeral Postgres service with `TEST_DB_WIPE=1` and a `DATABASE_URL` containing `test`.
- Branch protection on `main`: PR workflow must pass.
**Effort:** 1-2 hrs.

#### H3. 2FA for owners (TOTP + recovery codes)
**Why:** §5 known gap. Owner credential compromise = full tenant takeover. Pen-tester will flag absence.
**Acceptance:**
- Schema: `users.totp_secret`, `users.totp_enabled_at`, `users.recovery_codes_hash` (array of bcrypt'd codes).
- Enrollment page at `/account/security` — QR code (otpauth URI), verify 6-digit code to commit, show 8 one-time recovery codes once.
- Login flow: if `totp_enabled_at` set, after password success ask for TOTP or recovery code before issuing JWT.
- Recovery code consumed on use (removed from array). Regen UX surfaces remaining count.
- Disable 2FA requires current password + valid TOTP.
- Owners only for v1 (staff later).
- Activity log: `account.2fa_enable`, `account.2fa_disable`, `account.recovery_code_used`.
- Rate-limit: `auth.totp` 5 / 15 min / user.
**Effort:** 3-4 hrs.

#### H4. /healthz + /readyz endpoints
**Why:** No deploy probe means a broken container can roll into rotation. Also unblocks E1 (staging) the moment it lands.
**Acceptance:**
- `/healthz` returns 200 with `{ status: "ok", uptime, version }` — no DB/Redis hit.
- `/readyz` returns 200 only when `SELECT 1` on Postgres + `PING` to Redis both succeed; 503 otherwise.
- Neither route consumes the rate-limiter or hits Sentry on success.
- Updated nginx template uses `/readyz` for upstream health.
**Effort:** 30 min.

#### H5. E2E smoke test (Playwright happy path)
**Why:** 15 tests is not enough. One end-to-end smoke prevents the worst regressions.
**Acceptance:**
- `tests/e2e/smoke.spec.ts` — signup → onboarding (Corner Store preset) → add product → record sale (cash) → confirm sale appears in `/sales` → `/insights` overview reflects it.
- Runs against a dockerized DB; wiped before each run via the same `TEST_DB_WIPE` gate.
- Wired into `main` workflow.
**Effort:** 3 hrs.

#### H6. Repo-level unit tests for money math
**Why:** Discount math, payroll period calc, leave-date overlap — three places a silent bug costs real money.
**Acceptance:**
- `tests/repo/sale-discounts.test.ts` — line discount, order discount, both stacked, free-item edge case, rounding direction.
- `tests/repo/payroll-period.test.ts` — hourly + fixed + hybrid, mid-period rate change (effective-from versioning honoured).
- `tests/repo/leave-overlap.test.ts` — overlap detection across submitted/approved leaves on the same employee.
**Effort:** 2 hrs.

#### H7. Pre-pentest security hardening pass
**Why:** Cheaper to fix obvious issues in-house than to pay vendor time to find them. Frees E2 to spend its calendar on real findings.
**Acceptance — review + fix on:**
- All `/api/*` POST routes: confirm CSRF posture (same-site cookies on; double-submit token for any state-changing GET).
- Every `requireTenant` / `requirePermission` call site: at least one server-side gate per mutation, not relying on client-side hiding.
- File-upload routes (team photo, settings logo): MIME sniff (not just extension), size cap, extension whitelist, stored outside web root, randomised filename.
- Rate-limiters: confirm every auth-adjacent endpoint is covered (sign-up, login, password forgot/reset/change, 2FA verify, account export).
- Secrets in env: zero defaults baked into source for `SECRET_KEY`, `AUTH_SECRET`, `PAYMOB_HMAC_SECRET`, `WHATSAPP_*`. App fails to boot if any are missing.
- Error responses: confirm no stack traces, no SQL fragments, no internal paths leak through `error.tsx` or API JSON in prod.
- WhatsApp webhook signature verification: constant-time compare (`crypto.timingSafeEqual`), not `===`.
- Drizzle queries: grep for raw `sql\`` template usage and audit each for injection paths.
- `next.config.ts`: `poweredByHeader: false`, security headers (X-Frame-Options, Referrer-Policy, Permissions-Policy) set in addition to CSP.
- Output findings + fix commit refs in `infra/pre-pentest-audit.md`.
**Effort:** 4-6 hrs.

#### H8. CSP headers
**Why:** Cheapest XSS defence-in-depth. Pen-tester will flag absence.
**Acceptance:**
- nginx template adds `Content-Security-Policy`: strict `default-src 'self'`, `script-src 'self' 'nonce-...'`, `connect-src 'self' https://sentry.io`, `img-src 'self' data: blob:`, `style-src 'self' 'unsafe-inline'` (relax later when Tailwind nonces land).
- Next middleware/layout emits per-request nonce, wired into inline scripts.
- Zero CSP violation reports in browser console after smoke walk: signup → onboarding → /sales → /insights → /settings.
- Report-only mode on staging for 1 week before enforcing in prod.
**Effort:** 1-2 hrs.

#### H9. Session revocation ("sign out everywhere")
**Why:** Today a leaked JWT is valid until expiry. After H3 (2FA) lands, owners will expect this control.
**Acceptance:**
- `users.token_version` int default 0.
- JWT callback includes `tv` claim from current `token_version`.
- Session callback rejects (forces re-login) if `tv` !== current.
- `/account/security` exposes "Sign out everywhere" → increments `token_version`, busts user-context cache via `bustUserContextCache(userId)`.
- Activity log: `account.session_revoke_all`.
**Effort:** 1-2 hrs.

#### H10. Password reset throttle by email
**Why:** §5 noted IP-only throttle leaks usage info to a rotating-IP attacker. Always-200 helps; belt + suspenders.
**Acceptance:**
- New limit `pwd.forgot.email` 3 / 1 hr / SHA-256(email).
- Consumed even on unknown emails (so timing doesn't leak existence).
- Tested with known + unknown email at the same hash — same response shape, same latency band.
**Effort:** 30 min.

#### H11. PDPL data-export endpoint
**Why:** Egyptian Law 151/2020 right-of-access. Privacy policy already promises it — must deliver.
**Acceptance:**
- `POST /api/account/export` — enqueues a job, returns 202 with a job id.
- Background worker assembles a zip: JSON dumps of products, sales, returns, expenses, suppliers, purchase orders, customers, attendance, payroll, leave requests, activity log — tenant-scoped via `withTenant`.
- Emails owner a signed download link (15 min TTL, single-use, served from a short-lived route with HMAC verification).
- Rate-limited 2 / 24 h / user.
- Activity log: `account.data_export_requested`, `account.data_export_downloaded`.
**Effort:** 3-4 hrs.

#### H12. Real account deletion + 30-day grace
**Why:** PDPL right-to-erasure. Today's "disable" is not erasure.
**Acceptance:**
- Owner `/account/security` → "Delete tenant" → confirms by typing tenant slug → sets `tenants.deletion_scheduled_at = now() + 30 days`.
- Login flow + middleware show banner + "Cancel deletion" button during grace; cancel clears `deletion_scheduled_at`.
- Cron sidecar at 03:00 UTC: hard-deletes any tenant past `deletion_scheduled_at` → cascade through every tenant-scoped table.
- Surviving `tenant_deletions` audit table records the deletion event (tenant id, slug snapshot, owner email, scheduled-at, deleted-at).
- Activity log: `tenant.deletion_scheduled`, `tenant.deletion_cancelled`, `tenant.deleted`.
**Effort:** 4-5 hrs.

---

### 7.2 Soft specs — defer past first paying customer

Trigger: real user complaint OR retention signal. Do NOT pre-build.

| ID | Spec | Trigger | Effort |
|---|---|---|---|
| S1 | Barcode scanner mode at POS (auto-focus, Enter = submit, SKU fast lookup) | First cashier asks | 4 hrs |
| S2 | Forgot-username flow for sub-accounts | First support ticket | 2 hrs |
| S3 | Inter-branch stock transfers (move qty A → B with audit) | Second branch added by any tenant | 1 day |
| S4 | Offline outbox per-row discard/retry UI | First failed sync drain | 4 hrs |
| S5 | Native `.xlsx` parser for bulk import | First import support ticket | 4 hrs |
| S6 | Loyalty points expiry cron + "refund as credit" toggle in returns | First loyalty programme query | 4 hrs each |
| S7 | Per-branch cash drawer reconciliation | First multi-branch tenant | 1 day |
| S8 | Structured logging migration (pino) | First incident where `console.log` grep is too slow | 1 day |
| S9 | Metrics endpoint (Prom exposition or push to Grafana Cloud free) | Same as S8 | 4 hrs |
| S10 | Object storage for uploads (S3-compatible) | Disk pressure on app server | 1 day |
| S11 | Audit-log monthly partitioning | Any tenant table crosses ~100 GB | 1 day |
| S12 | SaaS-side VAT invoice for the subscription itself | Our own VAT registration filed | 1 day |
| S13 | Annual / multi-month plans | First customer asks | 4 hrs |
| S14 | Dunning emails (day 1/3/6 of grace) on failed payments | First failed-payment churn | 4 hrs |
| S15 | Staff performance leaderboard (commissions, targets, bonus calcs) | Owner asks for commission view | 1 day |
| S16 | Cart's product picker falls back to offline snapshot | Offline POS user reports missing picker | 2 hrs |

---

### 7.3 External-dependency specs — blocked on someone else

In-repo work that's gated on an outside party. Document the trigger so we move the moment it's unblocked.

#### E1. Staging environment provisioning
**Blocked on:** Hosting decision (Hetzner / DigitalOcean / similar) + box provisioning.
**In-repo deliverable when unblocked:** `docker-compose.staging.yml`, `infra/deploy-staging.md` runbook, GitHub Actions workflow that auto-deploys `main` → staging on green.
**Pre-requisite from §7.1:** H4 (/healthz + /readyz) so the deploy has a probe to flip rotation on.
**Effort once unblocked:** 1 day.

#### E2. Penetration test
**Blocked on:** Vendor selection + budget.
**Recommended scope:** external + authenticated app pentest, RLS bypass attempts (cross-tenant via crafted JWT / URL tampering), file-upload abuse, payment-flow review (after E3 is live), WhatsApp webhook spoofing.
**Pre-work in §7.1:** H7 (hardening pass) — done last so all prior in-house work is in scope.
**In-repo deliverable:** `infra/pentest-scope.md` (scope-of-work draft, ready to send to vendors), `infra/pentest-findings.md` (post-engagement remediation log).
**Effort:** ~1 week vendor calendar + 2-3 days to fix findings.

#### E3. Paymob go-live
**Blocked on:** Merchant account approval + credential issue. Per memory: skip until provider is ready.
**Trigger checklist (already in §3 Week 3.5):** fill 4 env keys → set callback + redirect URLs → 1-EGP test charge → failure-path test → idempotency replay test.
**Effort once unblocked:** half-day end-to-end test.

#### E4. SMS fallback (Vodafone Egypt Gateway / EgyptSMS)
**Blocked on:** Local SMS provider signup. Twilio is unreliable in Egypt — do not use.
**In-repo deliverable when unblocked:** `lib/sms/<provider>.ts` adapter mirroring the WhatsApp send interface, fallback logic in `lib/notifications.ts` (try WhatsApp → SMS on failure with shared rate-limit).
**Effort once unblocked:** 1 day.

#### E5. ETA e-invoicing (Path A — real integration with مصلحة الضرائب)
**Blocked on:** First VAT-registered paying customer asking. v1 ships Path B (disclaimer) per §6 decision log.
**Effort once unblocked:** 2 weeks.

#### E6. WhatsApp Cloud template approvals
**Blocked on:** Meta business verification + per-template review (24-48 hr each).
**Already done in repo:** template sync + cache (Phase 5).
**What's blocked:** every new operational template needs Meta approval before send.
**Effort:** ongoing operational, not code.

#### E7. Smart Payment Tracking (VF Cash / InstaPay auto-detect)
**Blocked on:** Mobile SMS-forwarder companion app (does not exist yet). Per memory: deferred.
**Effort once unblocked:** 1 week server + 2-3 days mobile companion.

---

### 7.4 Recommended execution order

Pure-code, sequential. Optimised for "ship → safe to charge → pen-test ready":

1. **H1** restore drill (30 min) — closes a known-unknown.
2. **H4** /healthz + /readyz (30 min) — unblocks E1 the moment it lands.
3. **H10** password reset email throttle (30 min) — free win.
4. **H2** CI pipeline (1-2 hrs) — every subsequent change is now safer.
5. **H6** money-math unit tests (2 hrs).
6. **H5** E2E Playwright smoke (3 hrs) — runs in CI from now on.
7. **H3** 2FA for owners (3-4 hrs).
8. **H9** session revocation (1-2 hrs) — pairs with H3.
9. **H8** CSP headers (1-2 hrs).
10. **H11** PDPL data export (3-4 hrs).
11. **H12** account deletion + grace (4-5 hrs).
12. **H7** pre-pentest hardening pass (4-6 hrs) — done last so all prior work is in scope.
13. **E2** penetration test (external; H7 makes the engagement productive).
14. **E3** Paymob 1-EGP test, **E1** staging cut-over (parallelisable with E2).

**Total in-house:** ~25-35 hrs of focused work, then pen test, then charge.

---

## How to use this file going forward

- Update Section 2 (Changelog) at the end of every working session, newest entry on top.
- Move items from Section 3 (Next) to Section 2 when shipped.
- Promote items from Section 4 (Backlog) to Section 3 when scheduled.
- Add to Section 5 (Gaps) any time you notice something but can't fix it yet — "known and tracked" beats "we forgot."
- Append to Section 6 (Decisions) any non-obvious choice the team makes, with the reason.
