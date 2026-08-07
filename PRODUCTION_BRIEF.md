# Matgary — Production Deployment Brief

*Written against `/Users/ahmed/Matgary` @ `db12ce2`. Every claim below was re-verified against the working tree; where the source audits disagreed, the repo settled it and the resolution is noted inline.*

---

## 1. What the product is

Matgary (branded "TheStoro" in outbound email) is an Arabic-first, multi-tenant POS / inventory / light-ERP SaaS for small Egyptian retailers. A shop owner signs up, gets a tenant with one or more **branches**, and runs the whole business from one app: a barcode-scanning cart POS with line/order/loyalty discounts and deferred partial payments, per-branch stock with an append-only product-history journal, purchase orders and supplier balances, customer receivables and a points/credit wallet, recurring expenses, staff attendance/payroll/tasks/leave, a receipt designer, WhatsApp messaging, and SQL-aggregated insights. Staff log in with synthetic `username@store-handle` identities under a 26-key permission model. A separate, deliberately invisible **platform-admin** plane (`/admin/*`) lets the operator suspend tenants, extend trials, edit the plan catalogue, impersonate owners, and read a full audit log. Billing is a single purchasable monthly plan through Paymob (currently unconfigured, therefore inert).

---

## 2. Architecture at a glance

**Stack.** Next.js 16.2.3 App Router (`output: "standalone"`, `next.config.ts`), React 19, TypeScript strict, Tailwind 4, Drizzle ORM over `postgres` (postgres-js) against Postgres 16, Redis 7, next-auth v5.0.0-beta.31, BullMQ, nodemailer.

**Processes.** One container serves everything. `instrumentation.ts` `register()` runs on boot and, when `NEXT_RUNTIME === "nodejs"`, starts Sentry, optionally OpenTelemetry (gated on `OTEL_SERVICE_NAME`), the **BullMQ WhatsApp worker in-process** (gated on `REDIS_URL`, `lib/whatsapp/worker-bootstrap.ts`), and optionally the activity-log worker (`ACTIVITY_LOG_QUEUE=1`). There is no standalone worker entrypoint and no worker service in `docker-compose.yml`; `Dockerfile` CMD is `node server.js`. Two BusyBox-cron sidecars (`backup`, `cron`) poke shell scripts and HTTP endpoints.

**Data stores.** One Postgres database, shared schema, 55 live tables, 46 migrations (`lib/db/migrations/`, verified count). Three Postgres roles: `matgary` (superuser, owns everything, migrations only — `DATABASE_URL`), `matgary_app` (NOSUPERUSER NOBYPASSRLS, all tenant traffic — `APP_DATABASE_URL`, created by `infra/init-postgres.sql`), `matgary_admin` (BYPASSRLS, `/admin/*` only — `ADMIN_DATABASE_URL`, created by `lib/db/migrate.ts:ensureAdminRole`). Pools: app `max:10 idle_timeout:20` (`lib/db/index.ts`), admin `max:8 idle_timeout:30` (`lib/admin/db.ts`), migrator `max:1`. **No statement_timeout, no connect_timeout, no SSL option on any pool.** Redis is opportunistic-but-load-bearing: cache, all rate limiting, password-reset tokens, impersonation tokens, SSE pub/sub, both BullMQ queues. Client-side: Dexie (`matgary_offline`) holds a POS outbox + a catalog snapshot; a hand-rolled `public/sw.js`.

**Request lifecycle.** `middleware.ts` is the single edge chokepoint and its matcher (`/((?!_next/static|_next/image|.*\.(?:png|jpg|…)$).*)`) runs on every `/api/*` route and on `/sw.js`. Order:

1. `/admin`, `/admin/*`, `/api/admin/*` → `gateAdminRequest()` (IP allowlist) → not an admin-public path and no `__matgary_admin_session` cookie → hard 404 → else **bare `NextResponse.next()` and return** (no CSP, no security headers, no nonce on the admin plane).
2. Mint CSP nonce (`x-nonce` request header).
3. Request id: reuse inbound `x-request-id` if it matches `/^[A-Za-z0-9._\-:]{1,128}$/`, else a fresh uuid.
4. Locale: path prefix > JWT `user.locale` > `NEXT_LOCALE` cookie > `ar` → `x-locale`.
5. Bare localized slug → 302 to `/{locale}/{slug}`.
6. `PUBLIC_PATHS` / `PUBLIC_PREFIXES` bypass.
7. No session → `/api/*` 401 JSON; `/` → `/{locale}/welcome`; else → `/{locale}/login?next=…`.
8. `tenantSuspendedAt` → 403 `TENANT_SUSPENDED` / `/service-paused`.
9. `mustChangePassword` → 403 `PASSWORD_CHANGE_REQUIRED` / `/account/change-password`.
10. Onboarding gate is a deliberate no-op (soft banner via `components/layout/OnboardingReminder.tsx`).
11. Demo session + full-page HTML nav → `x-demo-reset: 1`.
12. `subscriptionAccessActive === false` → 402 `SUBSCRIPTION_REQUIRED` / `/billing`.
13. `passThrough()`: CSP + hardening headers + `x-request-id` + locale cookie.

Handlers then call `requireTenant()` / `requirePermission()` (`lib/api/auth-helpers.ts`), resolve the active branch from the HttpOnly `mg.branch` cookie (`lib/api/branch-context.ts`), and run work inside `withTenant(tenantId, fn)` — a transaction that does `select set_config('app.tenant_id', $1, true)` so RLS fires. `withTenant` appears ~241 times.

---

## 3. Tenancy & security model

**Two isolation layers.** Application code filters by `tenant_id` explicitly; RLS is the safety net. 41 tenant tables carry an identical policy shape — `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid` for USING and WITH CHECK (canonical form set in `lib/db/migrations/0004_rls_nullif_guard.sql`; the NULLIF guard makes an un-scoped query return zero rows instead of a uuid cast error). Tenant context is **per-transaction**, never per-connection or per-request. 14 tables have no RLS by design: the Auth.js/tenancy bootstrap tables (`users`, `accounts`, `sessions`, `verification_tokens`, `tenants`, `tenant_members`, `tenant_deletions`), `wa_webhook_events` (quarantined rows carry `tenant_id NULL`), and the six platform-admin tables (no `tenant_id` column). `notification_preferences` (0044) and `notification_digest_queue` (0045) got ENABLE without FORCE — inconsistent, not exploitable under `matgary_app`.

**Second axis: branch.** `branch_id` scoping is **100% application-enforced** — RLS only ever checks `tenant_id`. Owners see all branches; staff see exactly `tenant_members.branch_id`. The `mg.branch` cookie is HttpOnly but **unsigned**, validated against a 60s-cached allow-list. `0015_multi_store_isolation.sql` reframes branches as independent franchises whose staff must not see each other's catalog/customers/suppliers/settings — any repo function that forgets its `branch_id` predicate leaks across branches even with RLS working. Four operational tables still have nullable `branch_id` from an unfinished rollout (`sales`, `purchase_orders`, `attendance_events`, `purchase_order_payments`).

**Tenant auth.** Auth.js v5, **JWT session strategy** (`lib/auth.config.ts`, maxAge 30d). The DrizzleAdapter is configured but the `sessions` table is not the source of truth. A fat JWT carries `tenantId/tenantSlug/role/permissions[]/mustChangePassword/subscriptionAccessActive/subscriptionStatus/tv/locale/tenantSuspendedAt/isDemo` + optional impersonation claims. Credentials provider only; bcrypt cost 12; identifier normalization is deliberately TLD-less so `user@store-handle` works. In-tree RFC 6238 TOTP (`lib/totp.ts`) + 8 bcrypt recovery codes, enforced inside `authorize()`. Two NextAuth instances exist: `middleware.ts` builds one from `authConfig` which has **no `jwt` callback**, so the edge decodes and trusts the JWT as-is.

**Revocation (H09).** `users.token_version` (`tv` claim) is compared in the Node-side `jwt` callback against a 60s-cached DB read (`lib/auth.ts:502`); a mismatch blanks `token.id` and the edge `session` callback returns `null`. Documented worst case ≥60s; a purely middleware-gated page navigation is not independently re-checked. The guard is `if (typeof token.tv === "number" && token.tv !== ctx.tokenVersion)` — a token lacking the claim skips it.

**Platform-admin auth.** Entirely separate: opaque 32-byte random token in `__matgary_admin_session` (httpOnly, sameSite=strict, secure when `NODE_ENV==='production'`, 8h), row in `admin_sessions`, 2h idle + 8h absolute TTL (`lib/admin/session.ts`). Roles `super_admin` / `ops_admin`; **all authorization denials return 404, not 403** (`lib/admin/permissions.ts`). Full audit log. Impersonation stages a one-time Redis token consumed by `authorize()`, with a hard 30-minute cap.

**Rate limiting.** One Redis ZSET Lua sliding window (`lib/ratelimit.ts`). It **fails open** — `return { ok: true }` at both line 77 (null client) and line 101 (any eval error). Buckets: `login.ip` 10/15m, `login.email` 5/15m, `auth.totp` 5/15m, `auth.2fa_needed` 30/1m, `pwd.forgot` 5/h, `pwd.forgot.email` 3/h, `pwd.reset.token` 20/h, `signup.ip` 5/h, `admin.login.ip` 3/15m, `admin.login.global` 30/5m, `cron.*` 6/h, plus the per-tenant registry in `lib/api/tenant-rate-limit.ts`.

**Client IP.** 30 call sites, all `x-forwarded-for`.split(',')[0] → `x-real-ip` → literal `"unknown"` (`lib/admin/middleware.ts:57`, `lib/cron/auth.ts`, `lib/auth.ts`, …). **Zero reads of `cf-connecting-ip`** (verified). `infra/nginx.conf.example` sets `X-Forwarded-For $proxy_add_x_forwarded_for` (append) with no `set_real_ip_from`.

**Encryption at rest.** AES-256-GCM, key = SHA-256(`SECRET_KEY`), envelope `v1:<iv>:<ct>:<tag>` (`lib/crypto.ts`). No key id, no keyring — rotation is destructive. Covers Green API tokens, Meta Cloud tokens (`lib/repo/settings.ts`), and `wa_connections.access_token`.

**Guardrail.** An ESLint `no-restricted-imports` rule bans `@/lib/admin/*` from `app/**`, `lib/**`, `components/**`, `hooks/**` (allow-list: `app/admin/**`, `app/api/admin/**`, `app/api/cron/admin-*/**`, `lib/admin/**`, `lib/db/migrate.ts`). It is **currently violated** by `lib/demo/clone-tenant.ts:16` (`import { getAdminDb } from "@/lib/admin/db"`), which is reachable from `app/layout.tsx` on every demo page render — and lint is non-gating in both CI workflows.

---

## 4. Feature inventory

**POS & sales** — Cart with per-line + order discounts, proportional allocation with last-line remainder absorption (`lib/repo/operations.ts`); deferred partial payment split proportionally and clamped per line to satisfy `sales_amount_paid_lte_total`; non-deferred methods always booked fully paid; barcode/QR scan with UPC-A↔EAN-13 normalization (`lib/sales/scan-cart.ts`); returns; sale edit; void/bulk-delete (hard DELETE, no tombstone, does not reverse loyalty or `sale_payments`); receipt designer with data-URI logo, reorderable blocks, ar/en/bilingual.

**Offline POS** — Dexie outbox with atomic `pending→syncing` claim, client-minted idempotency key + invoice id, 4xx terminal / 5xx retry to 8 attempts, server-side idempotency-key response caching, `X-Outbox-Branch` 409 on mismatch. **The read path is dead** — `readSnapshot()`/`isStale()` have zero call sites; `useProducts()` unconditionally does `fetch('/api/products', {cache:'no-store'})`, so a cold offline load has no catalog.

**Inventory** — Per-branch products (`products.branchId` *is* the branch context), categories, category attributes + values, brands, product history (`sold`/`returned`/`restocked`/manual adjust), low-stock thresholds, CSV import with SKU-keyed upsert. **No inter-branch stock transfer exists.**

**Purchasing & suppliers** — Draft→received POs, receive materialises external (`productId=null`) lines into real catalog products deduped case-insensitively by name, debits supplier balance; PO payment ledger with over-payment refusal and reversal.

**Customers & receivables** — Customers are **derived from `sales.customer_phone`** (no customers table, no merge, no rename); Egyptian phone normalization (`lib/validators/egypt.ts`); oldest-first settlement writing `sale_payments` events; loyalty wallet (points + EGP credit) keyed `(tenant, branch, phone)` with an append-only event log.

**Expenses** — One-off + recurring with a 12-period catch-up materialiser that runs lazily on every `listExpenses` and from `/api/cron/recurring-expenses`; supplier-linked expenses debit the balance.

**HR** — Attendance (manual + geofenced check-in with inline haversine), store-location geofences, versioned compensation, payroll computation (fixed/hourly/hybrid, weekend-as-overtime), tasks, leave requests.

**Insights & reports** — SQL-aggregated dashboard + overview with 60s Redis cache and bust-on-mutation; deep-dive (compare periods, hour heatmap, payment mix, branch comparison, product drill-down); `/reports` is client-side aggregation over `?all=1` full history and is in neither nav.

**WhatsApp** — Two independent stacks: legacy Green API proxy (per-branch creds in `shop_settings`, token embedded in the **URL path** of the outbound request) and full Meta Cloud API (embedded-signup OAuth with AUTH_SECRET-signed state, HMAC-verified webhook, BullMQ queue with 5 job kinds, conversations + Meta 24h window, templates, quarantine replay).

**Notifications** — Working in-app bell: `notifications` table + Redis marker pub/sub + SSE at `/api/notifications/stream`, produced **only** by `lib/repo/tasks.ts` and `lib/repo/leave-requests.ts`. The 0044/0045 "notification infra" (`lib/notifications/dispatch.ts:fanoutEvent`, preferences, digest queue) is **dead code** — verified zero callers, no settings UI, and the drain cron named in `0045`'s header (`app/api/cron/notifications-digest`) does not exist.

**Daily owner digest** — WhatsApp-only, `app/api/cron/digest-tick/route.ts`; `digest_settings.email_fallback` is editable in the UI and read by nothing.

**Billing** — Paymob Accept iframe, one purchasable plan (`z.enum(["professional"])` hard-coded), DB-backed plan catalogue (`platform_plans`) editable at `/admin/plans` with If-Match locking, 30-day trial + 7-day past-due grace, read-time `isAccessActive`. No renewal, no dunning, no expiry notification; status `expired` is declared but never written.

**Platform admin** — Tenant list/detail/activity, suspend/unsuspend, extend trial, impersonate, plans editor, admins CRUD, audit log with pg_trgm search, broadcasts.

**Demo mode** — Per-visitor tenant clone through the BYPASSRLS pool with in-memory UUID remapping; `x-demo-reset` header re-clones on full-page nav.

**Onboarding / i18n / PWA** — 2-step wizard + 13-slide fullscreen tour; exactly two locales (`ar` default RTL, `en`), dictionaries at exact 2886-key parity but 47/249 UI files still hardcode Arabic including all three error boundaries; a service worker but **no web app manifest and no PWA icons** — not installable.

**Cash shifts / Z-report** — `cash_shifts` + `cash_movements` tables and FK columns exist (migration 0032); there is no repo module, no route, no page, no permission. Doc-comments in `settleCustomerPayment` and `addExpense` claim shift stamping that does not happen.

---

## 5. The complete environment variable contract

### 5a. Must set for production

| Var | Required? | Purpose | If missing |
|---|---|---|---|
| `DATABASE_URL` | Yes | Superuser conn used by migrations, drizzle-kit, seeds, tests | Hard throw at import: `drizzle.config.ts`, `lib/db/migrate.ts`, `tests/setup.ts`. If `APP_DATABASE_URL` is also unset, `lib/db/index.ts` throws and the app cannot boot |
| `APP_DATABASE_URL` | Yes | NOSUPERUSER NOBYPASSRLS runtime pool — the thing that makes RLS actually fire | **Silently falls back to `DATABASE_URL`** (`lib/db/index.ts:8`). Every tenant query runs as superuser; RLS is bypassed entirely. No error, no log, no health signal. Highest-severity unset-var outcome in the repo |
| `ADMIN_DATABASE_URL` | Yes | BYPASSRLS pool for `/admin/*` and demo-tenant cloning | `getAdminDb()` throws; every `/admin` page and `/api/admin/*` route 500s; demo clone/reset breaks. `isAdminPoolConfigured()` exists for a clean 503 |
| `ADMIN_DB_PASSWORD` | Yes | Password set on the `matgary_admin` BYPASSRLS role **at migrate time** | Defaults to the literal `matgary_admin` (`lib/db/migrate.ts:92`) — a published credential for a role that reads/writes every tenant with RLS off. Must match `ADMIN_DATABASE_URL` |
| `AUTH_SECRET` | Yes | Auth.js JWE signing **and** WhatsApp OAuth state HMAC | Auth.js `MissingSecret` → nobody can log in; `lib/whatsapp/oauth-state.ts:41` throws. Dockerfile injects a **build-only** placeholder (builder stage does not propagate to runner) |
| `SECRET_KEY` | Yes | SHA-256'd into the AES-256-GCM key for WhatsApp tokens at rest | `getKey()` throws on first encrypt/decrypt — settings save and every WhatsApp send 500s. **Rotating it makes existing `v1:` ciphertext permanently undecryptable** (no key versioning) |
| `CRON_SECRET` | Yes | Bearer for `/api/cron/*`, constant-time compared | Every cron route 401s (fail-closed, no open mode). Recurring expenses only materialise lazily, audit logs grow forever, scheduled deletions never run, digests never send. Compose cron sidecar refuses to start |
| `REDIS_URL` | Yes in prod | Cache, **all** rate limiting, password-reset tokens, impersonation tokens, SSE pub/sub, both BullMQ queues | Rate limiting **fails open globally** (login, admin login, TOTP, forgot-password, signup, cron all unthrottled simultaneously); password reset silently stops (`issueResetToken` returns `emailExists:false`); impersonation 503s; the WhatsApp worker never boots; **`/readyz` still returns 200** with `redis:"disabled"` |
| `NEXT_PUBLIC_APP_URL` | Yes | Base URL in digest links (`app/api/cron/digest-tick/route.ts:42`, `app/api/digest/preview/route.ts:52`) | Falls back to `http://localhost:3000`. **Verified: this is a server-side read that survives the build un-inlined — runtime `env_file` injection works, no rebuild needed.** Absent from `.env`, `.env.example`, compose, and Dockerfile |
| `NODE_ENV=production` | Yes | Secure flag on all app-set cookies, JSON logs, drops CSP `unsafe-eval`, SW registration | Non-production semantics: `__matgary_admin_session`, `mg.branch`, and the WhatsApp OAuth state cookie ship **without Secure**. Set by the Dockerfile and compose — only a risk on a bespoke runner |
| `BOOTSTRAP_ADMIN_EMAIL` | Set it | Email of the seeded platform super_admin | Defaults to `admin@matgary.com`. The password is the hardcoded constant `12345678` regardless (`lib/db/migrate.ts:12`) |
| `ADMIN_IP_ALLOWLIST` | Set it | Comma-separated bare IPs / IPv4 CIDRs gating `/admin/*` and `/api/admin/*` | Empty = **no IP gate at all**. Read at module scope → needs a container restart, not just an env change. IPv4-only matcher: an IPv6 operator is hard-404'd |
| `CSP_ENFORCE=1` | Set it | Flips `Content-Security-Policy-Report-Only` → `Content-Security-Policy` | CSP is decorative — it neither blocks nor reports (no `report-uri`/`report-to`). Read at module scope; restart required |
| `SMTP_HOST` | Yes (for password reset) | Mail transport host — set to `smtp.resend.com` for Resend | `sendMail` prints the **entire message body, including the live reset link**, to stdout and returns `{delivered:false}`. Transport (including the null case) is memoized at module scope — a container that boots without it stays log-only forever |
| `SMTP_PORT` / `SMTP_SECURE` | Yes | 465+`1` (implicit TLS) or 587+`0` (STARTTLS); both valid for Resend | Defaults 587 / `false` |
| `SMTP_USER` / `SMTP_PASS` | Yes | For Resend: user is the literal `resend`, pass is the `re_…` API key | No auth attempted / empty password → provider rejects, `{delivered:false, reason:'send_failed'}`, silent to the user |
| `MAIL_FROM` | Yes | The only From address in the app (`lib/mailer.ts:49-50`); no per-message override exists | Falls back to hardcoded `TheStoro <no-reply@thestoro.com>` — fails SPF/DKIM unless that exact domain is verified with the provider |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | If WhatsApp used | Meta subscription handshake | GET returns 500 `Server misconfigured`; the webhook can never be registered |
| `META_APP_SECRET` | If WhatsApp used | HMAC key for `X-Hub-Signature-256` | Every inbound webhook POST 401s (fail-closed). To Meta the endpoint looks alive; inbound messaging is simply dead |

### 5b. Optional / feature-gated

| Var | Required? | Purpose | If missing |
|---|---|---|---|
| `ADMIN_IP_ALLOWLIST_BYPASS_USER` | Optional | `x-admin-bypass: <value>` skips the IP allowlist | No escape hatch — a wrong allowlist locks operators out until a restart. Note: no rate limit, no audit row, no format constraint on this bearer-equivalent |
| `META_APP_ID` / `META_OAUTH_REDIRECT_URL` | If embedded signup | `assertMetaConfigured()` requires both | OAuth start 500s; manual Phone-Number-ID + token fallback still works |
| `META_CONFIG_ID` | Optional | Login-for-Business config → embedded-signup wizard | Generic FB permissions page instead of the WABA wizard |
| `META_GRAPH_VERSION` | Optional | Graph version | Defaults `v21.0` in **two independent places** (`lib/whatsapp/meta-graph.ts:55`, `lib/whatsapp/outbound-sender.ts:13` at module load) — they can drift, and the send path needs a restart to pick up a change |
| `PAYMOB_API_KEY` / `PAYMOB_HMAC_SECRET` | If billing | `readConfig()` truthiness-gates both first | `isPaymobConfigured()=false` → `/api/billing/subscribe` 503s, webhook 401s, `/billing` disabled. Clean fail-closed. **Verified: all four are present-but-empty in `.env` today, so billing is currently correctly disabled** |
| `PAYMOB_INTEGRATION_ID` / `PAYMOB_IFRAME_ID` | If billing | Numeric ids, validated with `Number.isFinite` | Unset → `NaN` → correctly rejected. **Present-but-empty → `Number("")===0` → `Number.isFinite(0)` is true → accepted.** Only reachable once the API key + HMAC are non-empty, at which point the Subscribe button enables and 502s / redirects to a dead `…/iframes/0` |
| `SENTRY_DSN` | Optional | Server + edge error capture | `Sentry.init` never called; `onRequestError` is a no-op. Absent from `.env` |
| `SENTRY_ENVIRONMENT` / `SENTRY_TRACES_RATE` | Optional | Env tag / trace sample | `NODE_ENV` / 0.1. `/healthz` + `/readyz` always sampled at 0 |
| `OTEL_SERVICE_NAME` | Optional | Gates `registerOTel()` | No tracer installed; `withSpan` resolves to a no-op. `OTEL_EXPORTER_OTLP_*` are read by the SDK, never by repo code. Note @vercel/otel samples 100% by default |
| `LOG_LEVEL` / `LOG_FORMAT` | Optional | Logger floor / JSON vs pretty | `info` + `json` in production |
| `ACTIVITY_LOG_QUEUE=1` | Optional | Moves audit writes onto BullMQ | Writes stay synchronous and strongly consistent |
| `ACTIVITY_LOG_RETENTION_DAYS` | Optional | Cleanup horizon, clamped 30..3650 | 730 days |
| `CACHE_DISABLED=1` | Optional | Redis kill switch | Redis used normally. **Setting it has the same fail-open security consequences as an unset `REDIS_URL`** |
| `CACHE_DEBUG=1` | Optional | Per-key hit/miss logging | Quiet |
| `TENANT_RATE_LIMIT_DISABLED` | Optional | Per-tenant limiter kill switch | Enforced (the correct production state) |
| `APP_VERSION` / `GIT_SHA` | Should set | `/healthz` version field | Reports `"dev"` in every container (`node server.js` does not set `npm_package_version`) — no way to confirm which build is live |
| `CRON_TARGET_URL` | Optional | Where the cron sidecar POSTs | Compose defaults to `http://host.docker.internal:3000` (assumes the app runs on the **host**); `.env.example` says `http://app:3000`. They disagree |
| `AUTH_URL` | Optional | Pins Auth.js's URL | Not needed (`trustHost: true` is hardcoded at `lib/auth.config.ts:11`), but setting it forces `https` and prevents header-derived cookie-prefix downgrade |
| `BACKUP_REMOTE_HOOK` | Should set | Off-site shipping hook in `infra/backup.sh` | **Unset in compose — every dump lives only on the same disk as the database** |
| `BACKUP_DIR` / `BACKUP_CRON` / `DAILY_KEEP` / `WEEKLY_KEEP` / `PG*` | Optional | Backup sidecar config | Hardcoded as literals in `docker-compose.yml` — host overrides do **not** work despite the comment implying otherwise |
| `RESTORE_CONFIRM=1` | Required to restore | Guard in `infra/restore.sh` | Script prints the target DB and exits 70 |
| `RECURRING_EXPENSES_CRON` / `ACTIVITY_CLEANUP_CRON` / `TENANT_DELETION_CRON` | Optional | Sidecar schedules | Hardcoded literals with no `${…}` substitution — not overridable from the host |

### 5c. Unused / legacy — do not configure

| Var | Status |
|---|---|
| `ADMIN_SESSION_SECRET` | **Dead.** Documented in `.env.example:16` and PROJECT.md as "signing key for the /admin session cookie". Zero reads repo-wide. Admin sessions are opaque 32-byte random DB tokens (`lib/admin/session.ts`). It **is** set in the live `.env` (44 chars) — an operator will believe rotating it rotates admin session security. Delete it from both files |
| `AUTH_TRUST_HOST` | Inert — `lib/auth.config.ts:11` hardcodes `trustHost: true`, which takes precedence. Present in `.env` |
| `NEXT_PUBLIC_SENTRY_DSN` | Inert as shipped — `next.config.ts` has no `withSentryConfig` wrapper, there is no `instrumentation-client.ts`, and nothing imports `sentry.client.config.ts`. It is also genuinely build-time inlined, so it would need a Dockerfile ARG even after wiring |
| `SENTRY_REPLAYS` | Read in the never-loaded client config **and** lacks the `NEXT_PUBLIC_` prefix — unreachable in the browser bundle either way |
| `NEXT_PUBLIC_META_APP_ID` | Documented in `.env.example` and `docs/whatsapp-onboarding.md`; read by zero lines. The flow is a server-side redirect, not the FB JS SDK |
| `NEXT_PUBLIC_FIREBASE_*` (6) | Dead pre-Postgres leftovers. `firebase` is not a dependency; the five `scripts/*.mjs` that read them parse a nonexistent `.env.local` and crash on import. Delete the scripts |
| `SMTP_FROM` | Named in `docs/specs/heavy-e2e-test-plan.md:68`. No code reads it — the variable is `MAIL_FROM` |
| `NEXTAUTH_SECRET` / `AUTH_SECRET_1..3` | Auth.js aliases; work but undocumented. `AUTH_SECRET_1..3` would give a rotation window that does not exist today |
| `TEST_DB_WIPE` | Test-only gate for `tests/isolation.test.ts`. Never set in production. Not documented in `.env.example` |
| `PLAYWRIGHT_*`, `TOUR_*`, `DEMO_TEST_BASE_URL`, `T100_*`/`T1K_*`/`T10K_*`, `BASE`, `BASE_URL`, `CONNS`, `DURATION`, `ITER`, `PRODUCTS`, `SALES`, `PREFIX` | Test/perf harness only |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Hardcoded in compose — cannot be overridden from the host as written |

---

## 6. How it runs — exact commands

**Local dev (host app + compose infra):**
```bash
cp .env.example .env          # then fill in AUTH_SECRET, SECRET_KEY, CRON_SECRET
docker compose up -d postgres redis     # == npm run db:up (postgres only)
npm ci
npm run db:migrate            # tsx lib/db/migrate.ts — schema + matgary_admin role + bootstrap admin + plan seed
npm run db:seed               # DESTRUCTIVE: TRUNCATEs 18 tables, then creates test@matgary.local / Test1234!
npm run dev                   # :3000
npm run dev:https             # needs ./certs/localhost{,-key}.pem
```

**Seeds (`scripts/` is excluded from tsconfig, so none of these are typechecked):**
```bash
npm run db:seed        # WIPES DB → test@matgary.local / Test1234!
npm run db:seed:three  # WIPES DB → 3 tenants, shared password Test1234!
npm run db:seed:rich   # WIPES DB → amr@matgary.local + 30 days of data (tour screenshots)
npm run db:seed:demo   # SAFE — scoped to the demo template tenant + its clones, idempotent
```
The first three have **no safety gate of any kind** — no `TEST_DB_WIPE` equivalent, no URL check, no prompt. Never run them against production.

**Docker compose:**
```bash
docker compose --profile app up -d --build   # app is behind profiles: ["app"]
docker compose --profile app logs -f app
docker compose --profile app down            # ALWAYS pass --profile app (see gap #17)
```
`docker-compose.override.yml` is gitignored and, on the current dev box, remaps published ports to 5436 / 6383 / 3002 with `!override`.

**Migrations:** forward-only, no down-files. Drizzle reads the newest row from `drizzle.__drizzle_migrations` and applies every journal entry whose `when` is greater, **all inside one transaction** — you cannot end up half-migrated. Two caveats: the `hash` column is written but **never compared**, so editing an applied `.sql` is silently ignored; and `meta/_journal.json` has a non-monotonic timestamp (`0005` when=1777807597818 > `0006` when=1777806184000), so any DB whose highest applied `created_at` equals 0005's value would skip 0006 (the migration that enables RLS on `sales`/`returns`/`expenses`) forever. Fresh installs are safe.

**Tests:**
```bash
npx tsc --noEmit                    # the ONLY gating quality check. Verified: exits 0 on a clean tree.
                                    # Run after `rm -f tsconfig.tsbuildinfo` — include covers .next/types/**
npx eslint                          # verified: 133 problems (42 errors, 91 warnings, 35 auto-fixable).
                                    # The "194-error backlog" cited in both workflow comments is stale.
npx vitest run                      # 12 files. 9 pure (120 tests, ~1.6s) need only a DATABASE_URL *string*.
npx vitest run tests/cache.test.ts tests/ratelimit.test.ts   # need a live Redis; self-skip if REDIS_URL unset,
                                                             # but THROW if set-and-unreachable (deliberate)
TEST_DB_WIPE=1 DATABASE_URL=postgres://…/matgary_test npx vitest run tests/isolation.test.ts
                                    # 13 tests. DESTRUCTIVE. Gate requires TEST_DB_WIPE=1 AND /test/ in the URL.
                                    # Needs DATABASE_URL as superuser (for TRUNCATE) and APP_DATABASE_URL as
                                    # matgary_app — pointing both at the superuser makes it pass vacuously.
npm run test:e2e                    # 14 specs / 55 tests, chromium, serial, workers:1. Builds and serves on :3100.
PLAYWRIGHT_NO_BUILD=1 npm run test:e2e                                   # reuse an existing build
PLAYWRIGHT_NO_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3001 npx playwright test
```

**Deployer validation sequence:** `npm ci` → `npx tsc --noEmit` → `npm run build` → `npm run db:migrate` → `npx vitest run` → `npm run test:e2e`.

**CI.** `.github/workflows/main.yml` (push to main): typecheck, lint (non-gating), applies `infra/init-postgres.sql` by hand, `db:migrate`, full vitest, Playwright chromium on :3100. `.github/workflows/pr.yml`: typecheck, lint (non-gating), and a vitest subset — **but it has only a Redis service, no Postgres and no `DATABASE_URL`, while `tests/setup.ts:4` throws unconditionally without it. That step cannot pass.** Verified. Neither workflow builds, tags, or pushes a Docker image.

---

## 7. Production deployment gaps, ranked

### BLOCKER

**B1 — `AUTH_SECRET` and `SECRET_KEY` are the identical dev placeholder.** Verified: both are 47 chars, byte-identical, and match `*dev-only*`. One string protects three trust domains — Auth.js JWE session signing, the WhatsApp OAuth state HMAC (`lib/whatsapp/oauth-state.ts:39`), and the AES-256-GCM key for every tenant's stored WhatsApp token (`lib/crypto.ts:11-15`). Knowing it lets an attacker forge a session for any user id; the edge has no defence because `middleware.ts`'s NextAuth instance has no `jwt` callback, and a forged token that simply **omits** the `tv` claim skips the revocation check entirely (`lib/auth.ts:502` guards with `typeof token.tv === "number"`).
**Action:** generate two independent values (`openssl rand -base64 32` each). Rotate `AUTH_SECRET` freely. **Do not rotate `SECRET_KEY` in place** — see B9. Harden the check to `if (token.tv !== ctx.tokenVersion)` so a missing claim fails closed.

**B2 — Bootstrap super_admin is `admin@matgary.com` / `12345678`, and `must_rotate` is not enforced on any API route.** `lib/db/migrate.ts:12` hardcodes `const BOOTSTRAP_PASSWORD = "12345678"` (bcrypt 12, `must_rotate=true`, `ON CONFLICT DO NOTHING`). Verified: `lib/admin/permissions.ts` — `requireAdmin`/`requireSuperAdmin`/`requirePermission` — contains **zero references to `mustRotate`**. `app/api/admin/auth/login/route.ts:147-148` sets the full 8h session cookie unconditionally on a correct password and returns `mustRotate` only as a client-side `redirectTo` hint. The rotation gate exists solely as `redirect()` inside 9 server *page* components. So: log in, ignore the hint, and drive all 28 `/api/admin/*` routes — impersonate any tenant owner, suspend tenants, mint more admins, edit plans. Compounding: `ADMIN_IP_ALLOWLIST` is empty (verified), the 3/15min admin-login bucket fails open, and lockout (`locked_until`) is set **only** by `/api/cron/admin-session-cleanup`, which the compose sidecar never schedules.
**Action:** (a) rotate the password on any deployed DB immediately; (b) replace the constant with a required `BOOTSTRAP_ADMIN_PASSWORD` env read that throws in production; (c) add `if (r.session.mustRotate) return 404` inside `requireAdmin()`, allow-listing only `/api/admin/auth/rotate-password` and `/logout` — one edit closes all 28 routes; (d) apply `locked_until` inline at login time; (e) make the admin-auth rate-limit buckets fail **closed**.

**B3 — Every credential in the shipped stack is a published default, and every service binds 0.0.0.0.** `docker-compose.yml` publishes `5434:5432`, `6381:6379`, `3000:3000` with no `127.0.0.1:` prefix (the override file remaps to 5436/6383/3002 — still all interfaces). Postgres is `matgary/matgary`; `matgary_app` is `matgary_app` hardcoded in `infra/init-postgres.sql:6` with no override hook; `matgary_admin` defaults to `matgary_admin`; Redis has **no `requirepass`**. `infra/nginx.conf.example:6-7` explicitly states it "Assumes the Next.js container listens on 127.0.0.1:3000" — compose does not do this. On a public VPS anyone who learns the origin IP owns the database, and clients reach the app directly on plain HTTP, bypassing Cloudflare's WAF, nginx TLS/HSTS, and — because Next derives the URL protocol from `x-forwarded-proto` (`base-server.js:571-575`) — causing Auth.js to drop the `__Secure-` prefix and the Secure flag on the session cookie (`@auth/core/lib/init.js:69`).
**Action:** prefix all three published ports with `127.0.0.1:` in **both** compose files (the override must use `!override`); add `--requirepass` to Redis; rotate all three DB passwords (parameterise `init-postgres.sql` via an entrypoint `.sh` with `psql -v`); `ufw default deny incoming`, allow 22 from your IP and 80/443 only from Cloudflare's published ranges; enable Cloudflare Authenticated Origin Pulls. Belt and braces on cookies: set `useSecureCookies: true` in `lib/auth.config.ts`.

**B4 — `npm run db:migrate` cannot run inside the production image.** `DEPLOYMENT_READINESS.md` §1.1 and the Dockerfile comment both assert it works. Verified false: the script is `tsx lib/db/migrate.ts`, and `.next/standalone/node_modules` contains exactly 26 nft-traced packages (`@fastify @img @next @opentelemetry @prisma @sentry @swc bullmq client-only debug detect-libc has-flag import-in-the-middle ioredis module-details-from-path ms next node-gyp-build-optional-packages postgres react react-dom require-in-the-middle sharp styled-jsx supports-color`) with an empty `.bin`. `tsx`, `dotenv`, `drizzle-orm`, `drizzle-kit`, `bcryptjs` are all absent. Copying `lib/db` + `drizzle.config.ts` achieves nothing. On a fresh VPS there is no supported way to create the schema.
**Action:** add a fourth Dockerfile stage `migrator` that keeps `--from=deps /app/node_modules` plus `lib/db`, `drizzle.config.ts`, `package.json`, with `CMD ["npx","tsx","lib/db/migrate.ts"]`; publish it as `matgary-migrate:<sha>` and run `docker compose run --rm migrate` before `up -d app`. (Alternative: `esbuild lib/db/migrate.ts --bundle --platform=node --outfile=migrate.cjs` in the builder.) Verify with `docker run --rm --entrypoint sh matgary-app:latest -c 'npm run db:migrate'` before trusting it, and correct the Dockerfile comment and the readiness doc.

**B5 — Password-reset links will point at `https://0.0.0.0:3000`.** `app/api/account/password/forgot/route.ts:78` builds the link from `req.nextUrl.origin`. In self-hosted standalone Next does **not** derive the origin from the Host header — verified: `.next/standalone/server.js` carries `"trustHostHeader":false`, and `resolve-routes.js:113-117` / `next-server.js:1261-1271` compute the URL from `opts.hostname`. The Dockerfile sets `ENV HOSTNAME=0.0.0.0`. The protocol *is* proxy-aware (correctly becomes `https` from `X-Forwarded-Proto`), which is why this is easy to miss. Invisible locally because `next dev`/`next start` leave hostname undefined → `localhost`. Same root cause makes NextAuth route-handler redirects absolute to the dead origin.
**Action:** either add `experimental: { trustHostHeader: true }` to `next.config.ts`, or (cleaner) stop deriving the origin from the request — read a server-side `APP_URL` env var in `forgot/route.ts` and reuse it for the digest links. Verify with `curl -H 'Host: your-domain' -H 'X-Forwarded-Proto: https' …` and read the emitted link.

**B6 — `docker compose --profile app up` does not produce a working app.** The app service overrides only `DATABASE_URL`, `APP_DATABASE_URL`, `REDIS_URL` to compose DNS. **`ADMIN_DATABASE_URL` is not overridden** and stays at the `.env` value pointing at `localhost:543x`, which inside the container is its own loopback — so `getAdminDb()` ECONNREFUSEDs and every `/admin/*` page, every `/api/admin/*` route, and the demo-clone path (reached from `app/layout.tsx` on every demo render) fails. Same class of bug in the cron sidecar: `CRON_TARGET_URL` defaults to `http://host.docker.internal:3000` while the app is a compose sibling on a remapped port.
**Action:** add `ADMIN_DATABASE_URL: postgres://matgary_admin:${ADMIN_DB_PASSWORD}@postgres:5432/matgary` to the app `environment:` block; set `CRON_TARGET_URL=http://app:3000` and drop `extra_hosts`; add the cron service to `profiles: ["app"]` with `depends_on: {app: {condition: service_healthy}}`.

**B7 — Backups exist only on the same disk as the database, and a restore does not restore the security model.** `BACKUP_REMOTE_HOOK` is unset in compose — host loss is total data loss. `infra/backup.sh` dumps with `--no-owner --no-privileges`, stripping all GRANTs; `infra/init-postgres.sql` runs only on a **fresh** Docker volume; `infra/restore.sh` is `gunzip | psql` and nothing more. After a real restore, `matgary_app` either does not exist or has no grants and the app fails closed. `infra/drills/restore-drill-2026-06-03.log` flags this and no script addresses it. Backup/cron logs go to `/var/log/*.log` inside containers with **no volume mount** — every `up -d --build` destroys the entire history, and nothing alerts if backups stop.
**Action:** set `BACKUP_REMOTE_HOOK` to a script doing `rclone copy "$1" remote:matgary-backups/` (Cloudflare R2 is S3-compatible with no egress fee — you are already on Cloudflare); add a post-restore step to `infra/restore.sh` that re-applies `init-postgres.sql` and re-runs `ensureAdminRole`; bind-mount `./logs/{backup,cron}:/var/log`; add a dead-man check alerting when the newest `daily-*.sql.gz` is >26h old; do one full restore drill on the actual VPS before go-live.

**B8 — Behind Cloudflare the app reads an attacker-controlled `X-Forwarded-For`.** Verified: zero reads of `cf-connecting-ip` anywhere; 30 call sites all take `xff.split(',')[0]`. `infra/nginx.conf.example` appends with `$proxy_add_x_forwarded_for` and has no `set_real_ip_from`. Cloudflare appends the connecting IP to any existing XFF, so element [0] is whatever the client sent. Consequences: `ADMIN_IP_ALLOWLIST` is satisfied with `curl -H 'X-Forwarded-For: <allowed-ip>'`, and every IP-keyed rate limit (login, admin login, forgot-password, signup, cron) is defeated by rotating a header value. Chains directly into B2.
**Action:** add `real_ip_header CF-Connecting-IP;` plus a `set_real_ip_from <cidr>;` per Cloudflare range, then change the proxy header to `proxy_set_header X-Forwarded-For $remote_addr;` (single-value overwrite). Factor the 30 duplicated helpers into one `lib/net/client-ip.ts` that reads `cf-connecting-ip` first and never trusts a multi-hop XFF. Until then, treat `ADMIN_IP_ALLOWLIST` as providing zero security.

**B9 — Rotating `SECRET_KEY` is irreversible data loss.** This is the trap set by B1. `lib/crypto.ts` derives the key as SHA-256(`SECRET_KEY`) with **no key id** — the `v1:` prefix is a *format* version. Decrypting with a different key throws a GCM auth-tag failure, and the throw is uncaught at the read sites (`lib/repo/settings.ts:320,355`, `lib/whatsapp/connections.ts`), so the request 500s. Mitigating: `decryptSecret` passes legacy plaintext through unchanged, so only values already written with the `v1:` prefix are at risk.
**Action:** before rotating, count exposure: `select count(*) from shop_settings where green_api_token like 'v1:%' or whatsapp_cloud_token like 'v1:%'` plus the same on `wa_connections.access_token`. If non-trivial, write a one-off re-encryption script (read with old key, write with new, one transaction) and run it before the new key goes live. Longer term add a key id to the envelope and wrap the two settings read sites in try/catch.

**B10 — No TLS/ACME plan that survives Cloudflare, and no deploy runbook at all.** `infra/nginx.conf.example` references `/etc/letsencrypt/live/your-domain.com/*` and says "run `certbot --nginx` once", but nothing installs certbot, schedules renewal, or reloads nginx. The `:80` block is `return 301` for **all** paths with no `location ^~ /.well-known/acme-challenge/` exemption, so webroot renewal breaks. No document states which Cloudflare SSL/TLS mode to use — with an orange-clouded record, "Flexible" makes Cloudflare speak HTTP to the origin, hits that unconditional redirect, and produces `ERR_TOO_MANY_REDIRECTS`. `docs/` contains only `specs/` and `whatsapp-onboarding.md`.
**Action:** simplest correct path for a Cloudflare-fronted origin — issue a 15-year **Cloudflare Origin CA** certificate, install it in nginx, skip ACME entirely, and set SSL/TLS mode to **Full (Strict)** with "Always Use HTTPS". If you prefer Let's Encrypt, add the acme-challenge location above the redirect and use `certbot certonly --webroot` with `--deploy-hook 'nginx -s reload'`. Also fix `listen 443 ssl http2;` → `listen 443 ssl;` + `http2 on;` (nginx ≥1.25). Write `docs/DEPLOY.md`: first-boot order (postgres/redis → migrator → app → nginx/TLS), routine deploy, rollback, restore-with-re-GRANT.

### HIGH

**H1 — The barcode scanner is disabled in production by the app's own header.** `middleware.ts` `SECURITY_HEADERS` sends `Permissions-Policy: camera=(), microphone=(), geolocation=(self)`, and nginx independently adds `camera=()`. `camera=()` is an empty allowlist — it denies `getUserMedia` even same-origin. The inline comment ("camera/microphone are not used by any current feature") is stale: `components/scanner/BarcodeScannerModal.tsx` is used by `ProductSearchSelect.tsx`, `Step3Details.tsx`, `EditProductModal.tsx`, and `InventoryClient.tsx`. Only surfaces on the real HTTPS domain.
**Action:** `"Permissions-Policy": "camera=(self), microphone=(), geolocation=(self)"` and update the comment. Delete the nginx `add_header Permissions-Policy` line so the app owns it (same rationale the file already gives for CSP). Smoke-test from a phone.

**H2 — Permission checks are missing on every money- and stock-mutating route.** Verified: 55 of 163 `route.ts` files call `requirePermission`, and the covered set is suppliers, purchases, team/attendance/payroll, insights, digest, activity, admin. Directly verified as **uncovered**: `POST /api/products`, `PATCH|DELETE /api/products/bulk`, `POST /api/sales/cart`, `POST /api/expenses`, `PATCH /api/settings` — plus `/api/products/[id]`, `/api/products/[id]/adjust`, `/api/sales/[id]`, `/api/sales/bulk`, `/api/sales/settle`, `/api/returns`, `/api/categories`, `/api/brands`, `/api/attributes`, and all of `/api/whatsapp/*`. `DEFAULT_STAFF_PERMISSIONS` gives a cashier only view_* + record_sales + request_leave, so a cashier with a valid session can `DELETE /api/products/bulk` the entire catalog, void or reprice sales, add expenses, or overwrite WhatsApp credentials by calling the API directly. The UI hides the buttons; nothing on the server rejects the call. PROJECT.md §19 asserts the opposite.
**Action:** add `requirePermission()` to every mutating route before exposing the app to real staff accounts. `/api/products/bulk` additionally has no rate limit and no activity-log entry — the highest-blast-radius operation is also the least observable.

**H3 — The Paymob webhook is 401'd by middleware before its handler runs.** Verified: `/api/billing/paymob/webhook` is in neither `PUBLIC_PATHS` nor `PUBLIC_PREFIXES` (which is only `/api/auth`, `/api/cron`, `/_next`, `/favicon`, `/fonts`). Paymob's S2S POST has no session, so the unauthenticated branch returns 401 first. The `/api/billing/*` suspension allowance is evaluated later. Latent today because all four `PAYMOB_*` vars are empty — but the moment real credentials are set, customers are charged and `payment_attempts` stay `pending` forever while the tenant is hard-locked at `/billing` with no self-serve escape.
**Action:** add `"/api/billing/paymob/webhook"` to `PUBLIC_PATHS` (the route self-authenticates via HMAC-SHA512, same rationale as the `/api/whatsapp/webhook` entry). Also tighten `readConfig()` at `lib/payments/paymob.ts:50` to `Number.isInteger(x) && x > 0` before enabling billing — present-but-empty ids currently pass `Number.isFinite`. Add all four names to `.env.example` (they are absent). Note two further design defects to fix before taking money: the HMAC field list omits `order.merchant_order_id` (the only carrier of `tenantId:planKey`), and `payment_attempts_paymob_txn_idx` is a plain index, not unique — so a replayed genuine webhook with a rewritten `merchant_order_id` settles against a different tenant.

**H4 — Two production paths read RLS-FORCEd tables on the un-scoped `db` handle and silently return zero rows.** Verified: `app/api/cron/digest-tick/route.ts:59` selects `digest_settings` with no `withTenant`; `lib/whatsapp/connections.ts:353,369` select `wa_connections` the same way (the header calls `db` "the admin handle" — it is the `matgary_app` pool). Both tables are ENABLE + FORCE RLS (`0033_daily_digest.sql:29-30`, `0019_wa_connections.sql:68-70`). With `app.tenant_id` unset the NULLIF-guarded predicate matches nothing. Result: the daily digest `continue`s for every tenant and never sends; every inbound Meta webhook fails tenant resolution and is persisted `tenant_id NULL / quarantined`. **These paths only work today because the dev deployment falls back to the superuser `DATABASE_URL` — they break precisely by configuring `APP_DATABASE_URL` correctly.**
**Action:** wrap the digest reads in `withTenant`; route the genuinely cross-tenant webhook lookup through `lib/admin/db.ts` with an explicit comment, or add a narrow RLS policy. Add a regression test that runs as `matgary_app` and asserts a non-zero row count.

**H5 — Half the scheduled work never runs, including the sweep that applies admin lockouts.** The cron sidecar materialises exactly three crontab lines (recurring-expenses, activity-log-cleanup, tenant-deletion). `/api/cron/admin-session-cleanup`, `/api/cron/digest-tick`, and `/api/cron/demo-cleanup` exist and have no scheduler anywhere in the repo. The first is security-relevant (see B2): admin lockouts are never applied and expired admin sessions are never purged. The others mean the digest never sends and demo clones accumulate forever.
**Action:** add three crontab lines using the existing `poke-cron.sh` wrapper. Note `digest-tick` at 30-min cadence is 48 pokes/day from one IP against a 6/hour bucket — raise that route's `limit` or the scheduler 429s itself silently.

**H6 — Cron routes rate-limit before authenticating, on a spoofable IP.** Verified in `lib/cron/auth.ts`: `rateLimit(...)` then `checkSecret(...)`. Three routes carry a byte-identical inline copy. Only `app/api/cron/tenant-deletion/route.ts` checks the bearer first. Combined with B8, an anonymous caller sends six requests with the sidecar's spoofed IP and silently disables recurring-expense materialisation, log pruning, and scheduled deletions — invisibly, since sidecar logs go to an unmounted file.
**Action:** swap the order in `lib/cron/auth.ts` and delete the three inline copies in favour of `guardCronRequest`.

**H7 — nginx sends `Connection: upgrade` on every request and drops all security headers on `/_next/static/`.** The catch-all `location /` sets `proxy_set_header Connection "upgrade";` unconditionally instead of via the `map $http_upgrade $connection_upgrade` idiom — malformed on the ~100% of non-WebSocket requests, and it kills upstream keep-alive. (Verified there is no WebSocket usage; the only streaming surface is SSE at `/api/notifications/stream`, which already has its own correct non-buffered block with a 6m timeout > the app's 5m `STREAM_MAX_DURATION_MS`.) Separately, the `/_next/static/` block declares its own `add_header Cache-Control`, and nginx `add_header` at a nested level **replaces** the parent's — so every static asset ships without HSTS, X-Frame-Options, nosniff, Referrer-Policy or Permissions-Policy.
**Action:** add the `map` block and use `$connection_upgrade`; add an `upstream matgary { server 127.0.0.1:3000; keepalive 32; }`; re-declare all five security headers inside the `/_next/static/` block (or `include snippets/security-headers.conf;` everywhere).

**H8 — The platform-admin plane ships with no security headers at all.** `middleware.ts` handles the admin branch **first** and returns a bare `NextResponse.next()` before `applyCsp` is reachable — so the highest-privilege UI in the product ships without CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, or an `x-nonce`. Only nginx's headers apply, and nginx explicitly declines to emit CSP.
**Action:** hoist the nonce mint above the admin gate and return `applyCsp(req, nonce, NextResponse.next())`.

**H9 — No container log rotation and no app healthcheck.** No `logging:` driver on any of the five services — Docker's default json-file driver is uncapped unless `/etc/docker/daemon.json` says otherwise, and `lib/logger.ts` writes one JSON line per event at `info` in production. The VPS root filesystem fills, taking Postgres and the backups with it. Separately, postgres and redis have healthchecks and the app `depends_on` both, but the **app itself has none** — `restart: unless-stopped` cannot detect a hung Node process, and nothing consumes `/readyz`.
**Action:** add `logging: {driver: json-file, options: {max-size: "20m", max-file: "5"}}` to each service and/or host-wide; add an app healthcheck hitting `/readyz` (`DEPLOYMENT_READINESS.md` §4.6 has the exact YAML); confirm `systemctl is-enabled docker`.

**H10 — `.env.example` is missing a third of what the app reads, documents one dead variable, and there is no env validation.** Absent: all four `PAYMOB_*`, `NEXT_PUBLIC_APP_URL`, `CSP_ENFORCE`, `LOG_LEVEL`/`LOG_FORMAT`, `APP_VERSION`/`GIT_SHA`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_TRACES_RATE`/`SENTRY_REPLAYS`, `OTEL_*`, `ACTIVITY_LOG_QUEUE`, `TENANT_RATE_LIMIT_DISABLED`, `TEST_DB_WIPE`, `BACKUP_REMOTE_HOOK`. Present-but-dead: `ADMIN_SESSION_SECRET`. Only four variables can abort startup; everything else degrades silently.
**Action:** bring `.env.example` to parity, grouped by required-in-prod vs optional. Delete `ADMIN_SESSION_SECRET` from `.env.example` and PROJECT.md. Add a `lib/env.ts` zod schema imported from `instrumentation.ts` that hard-fails the boot in production on any missing required var — **and, critically, runs `SELECT current_user, usesuper` at boot and refuses to serve if the runtime role is superuser or BYPASSRLS.** That one check converts the single highest-severity silent misconfiguration in this codebase (`lib/db/index.ts:8`) into a loud boot failure.

**H11 — No image tagging, no rollback artifact, and `/healthz` cannot tell you which build is live.** Neither workflow builds or pushes an image; `docker compose build` produces the mutable `matgary-app:latest`. With 46 forward-only migrations and zero down-files, a bad migration's only recovery is the restore path — which itself does not restore GRANTs (B7). `app/healthz/route.ts` reports `APP_VERSION || GIT_SHA || npm_package_version || "dev"`; the Dockerfile sets none and `node server.js` does not populate the third, so every container reports `"dev"`.
**Action:** add `ARG GIT_SHA` / `ENV GIT_SHA` to the runner stage, build with `--build-arg GIT_SHA=$(git rev-parse --short HEAD)`, tag as `matgary-app:$GIT_SHA`, and pin `image: matgary-app:${APP_TAG:-latest}` so rollback is `APP_TAG=<old-sha> docker compose --profile app up -d`. Assert `curl -s https://domain/healthz | jq -r .version` after every deploy.

**H12 — Email delivery failure is completely silent.** `sendMail` never throws by design and both call sites discard the result: `app/api/account/password/forgot/route.ts:83` awaits it and returns `{ok:true}` unconditionally (correct for the existence-oracle defence, but a total outage looks identical to success), and `lib/notifications/dispatch.ts:224` is dead code. The only trace is one `logger.error` line to stdout, with no shipper and no alerting configured. Paste a typo'd Resend key at cutover and password reset is dead for everyone, indefinitely, with no alarm. Worse, with `SMTP_HOST` blank the mailer **console.logs the entire body including the live reset URL** to stdout — a botched cutover window leaks account-takeover tokens into the log driver.
**Action:** route `mailer.send_failed` to `Sentry.captureMessage`; gate the dev console.log on `NODE_ENV !== 'production'`; add a synthetic canary send after cutover. **Also add explicit timeouts to the transport** — `connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000` — because there is no queue and the send is awaited inline; nodemailer's defaults would hold the HTTP request open for minutes against a stalled endpoint.

### MEDIUM

**M1 — Redis is `allkeys-lru` with no persistence, but BullMQ requires `noeviction`.** `bullmq/dist/cjs/classes/redis-connection.js:434` emits `IMPORTANT! Eviction policy is allkeys-lru. It should be "noeviction"` — a warning, not a throw. Under memory pressure Redis evicts arbitrary keys including BullMQ job hashes. The same instance holds the only copy of password-reset tokens and impersonation tokens, and with `--save "" --appendonly no` any restart invalidates every outstanding reset link.
**Action:** flip the shared instance to `noeviction` and size `maxmemory` for the real working set (a separate logical DB does **not** help — the policy is server-wide). Decide whether reset tokens should survive a restart; if so, enable AOF.

**M2 — No `statement_timeout`, `idle_in_transaction_session_timeout`, or `connect_timeout` on any pool.** App ceiling is 10 connections. One slow query inside `withTenant` holds a transaction and a pooled connection indefinitely; ten of them wedge the app while `/readyz`'s own 1s `select 1` starts failing. `/reports` (full sales + returns history with `?all=1`) is the obvious trigger.
**Action:** add `connect_timeout: 10, connection: { statement_timeout: 15000, idle_in_transaction_session_timeout: 30000 }` to both pools, and `ALTER ROLE matgary_app SET statement_timeout = '15s'` server-side (add to `init-postgres.sql` and the post-restore script).

**M3 — `/sw.js` is redirected to `/login`, so service-worker registration and updates hard-fail.** The middleware matcher excludes images/fonts/audio but **not `.js`**, and `/sw.js` is in neither public set. The SW Update algorithm sets the script request's redirect mode to `"error"`, so a 3xx is a hard failure — pinning users on a stale worker. Production-only, because `SwRegister.tsx:16` bails out entirely when `NODE_ENV !== 'production'`.
**Action:** add `"/sw.js"` to `PUBLIC_PATHS` (and `"/manifest.json"` when it lands), or extend the matcher's lookahead.

**M4 — `/readyz` reports 200 when Redis is simply absent.** `checkRedis()` returns `{ok:true, status:"disabled"}` for a null client. The HTTP status — the only thing nginx, Cloudflare Health Checks, or an orchestrator reads — does not distinguish "intentionally disabled" from "we lost the cache, all rate limiting is now fail-open, and the queue worker never booted".
**Action:** return `{ok:false}` when `NODE_ENV === 'production' && !redis`, keeping `CACHE_DISABLED=1` as an explicit opt-out.

**M5 — CSP ships Report-Only with no report endpoint, and enabling it will collide with Cloudflare.** `CSP_ENFORCE` is set nowhere. (Verified good news: the compiled edge chunk retains a literal `process.env.CSP_ENFORCE` read — it is **not** build-time inlined, so flipping it needs only a restart. Same for `ADMIN_IP_ALLOWLIST`.) `script-src 'self' 'nonce-…' 'strict-dynamic'` will break under Cloudflare Rocket Loader and Email Address Obfuscation, both of which inject un-nonced inline scripts at the edge; Auto Minify can alter the markup Next generated for the nonce. `style-src` still carries `'unsafe-inline'` for Tailwind 4.
**Action:** disable Rocket Loader, Email Obfuscation, Mirage, and Auto Minify on the zone; add a `report-uri`/`report-to` (Sentry's CSP endpoint) and soak Report-Only on the real domain for a few days; then set `CSP_ENFORCE=1` and restart.

**M6 — Body-size limits disagree: Next buffers 10MB, nginx allows 25MB.** Because middleware runs on essentially every route, Next clones and buffers each request body; `experimental.proxyClientMaxBodySize` defaults to 10485760 (verified in the compiled config). Per Next's own docs the over-limit behaviour is explicitly non-failing — it buffers the first N bytes with only a console warning. Any 10–25MB request (CSV import, PDF via `/api/whatsapp/send-pdf`) reaches the handler **silently truncated**.
**Action:** pick one number. Set `experimental.proxyClientMaxBodySize: '25mb'` in `next.config.ts`, or lower nginx's `client_max_body_size` to `10m` so oversized uploads get a clean 413.

**M7 — `docker compose down` tears the network out from under the profiled app.** The app is behind `profiles: ["app"]` but postgres/redis/backup/cron are not, and `npm run db:down` is a bare `docker compose down`. Without `--profile app` this removes the shared network while `matgary-app` still holds an endpoint — the container stays "up" but cannot resolve `postgres` or `redis`, and (with no healthcheck) is never restarted.
**Action:** set `COMPOSE_PROFILES=app` on the VPS; change `db:down`/`db:up` in `package.json` to be explicitly infra-scoped.

**M8 — `pg_stat_statements` collects nothing, and no alerting exists.** Migration `0039` creates the extension and its own header warns the compose image does not preload the library — and `docker-compose.yml`'s postgres service has no `command:` setting `shared_preload_libraries`. Every column reads zero, silently invalidating `ALERTING.md` §5.3 and the §1.1 POS runbook step. More broadly, `ALERTING.md`'s 21 thresholds are a specification with no implementation — no Prometheus, exporter, Alertmanager, Grafana, or Sentry alert-rule-as-code anywhere.
**Action:** add `command: ["postgres","-c","shared_preload_libraries=pg_stat_statements","-c","pg_stat_statements.track=all"]` and restart (not reloadable). For a single VPS the cheapest real alerting is an external check against `https://domain/readyz` (Cloudflare Health Checks) plus a host cron alerting on `df -h` >80% and on stale backups. Set `SENTRY_DSN` so server exceptions surface at all.

**M9 — Migration post-DDL steps hardcode the database name, require true superuser, and swallow every failure.** `ensureAdminRole()` issues `ALTER ROLE matgary_admin BYPASSRLS` and `GRANT CONNECT ON DATABASE matgary` with the name as a literal. All three post-DDL steps are individually try/caught with only a `console.warn`, and `db:migrate` exits 0 regardless. On any DB not literally named `matgary` (or on managed Postgres where BYPASSRLS needs superuser) the role is created without its grants and `/admin` silently sees nothing — with a clean-looking deploy log.
**Action:** derive the database name from the parsed URL; make the failures fatal when `ADMIN_DATABASE_URL` is configured; assert `SELECT rolbypassrls FROM pg_roles WHERE rolname='matgary_admin'` after the ALTER.

**M10 — The edge Sentry config omits the PII scrubbers, and browser Sentry is dead code.** `sentry.server.config.ts` wires `beforeSend`/`beforeBreadcrumb` to `lib/sentry/scrub`; `sentry.edge.config.ts` wires neither — and the edge runtime is exactly where middleware handles cookies, Authorization headers, and `x-admin-bypass`. Separately `next.config.ts` has no `withSentryConfig`, there is no `instrumentation-client.ts`, and nothing imports `sentry.client.config.ts` (verified: zero hits for `NEXT_PUBLIC_SENTRY_DSN` in `.next/static`), so there is no client capture and — because `withSentryConfig` is also what uploads source maps — server stack traces will be minified.
**Action:** copy the two hooks into the edge config **before** setting `SENTRY_DSN`. Wrap `next.config.ts` and add `instrumentation-client.ts` if browser capture is wanted; that needs a Dockerfile build ARG for the public DSN plus `SENTRY_AUTH_TOKEN`/org/project.

**M11 — Resend cutover mechanics.** Good news: `lib/mailer.ts` is provider-agnostic — a bare nodemailer transport with no pool, no DKIM, no custom headers. **Only three variables change: `SMTP_HOST=smtp.resend.com`, `SMTP_USER=resend`, `SMTP_PASS=<re_… API key>`.** Leave 465/`1` as-is (Resend supports implicit TLS on 465). No code change. `.env.example:53-57` is already written for Resend. Two hazards: (a) `MAIL_FROM` is currently `TheStoro <support@thestoro.com>` and `support@` is a **live receiving mailbox** — verify the domain in Resend and paste its records at the names Resend gives you, never the apex, or the apex MX for inbound mail breaks; (b) the transport is memoized at module scope and compose reads `.env` at container-create time, so cut over with `docker compose --profile app up -d --force-recreate app`, not a restart or a bare file edit. Verify in this order to isolate variables: `docker compose --profile app exec app node scripts/test-smtp.mjs you@domain` (it calls `transport.verify()`, which the app never does) → confirm `/readyz` body says `redis:"ok"` not `"disabled"` (with Redis down, `issueResetToken` returns `emailExists:false` and **no email is attempted at all**, while the endpoint still returns 200 — a false negative that will send you hunting Resend) → then the real forgot-password flow → then check the received message's `Authentication-Results` for `spf=pass dkim=pass dmarc=pass`. Note `scripts/test-smtp.mjs` has three defects: it defaults `SMTP_PORT` to 465 (the app uses 587), it has no `MAIL_FROM` fallback, and it reads the on-disk `.env` via `dotenv/config` rather than container env. Add DMARC at `_dmarc.thestoro.com` starting `v=DMARC1; p=none; rua=…`, tighten after a week. There is **no bounce/complaint handling of any kind** (verified: zero matches for bounce/complaint/suppress/unsubscribe) — when you add a Resend webhook, remember to add its exact path to `PUBLIC_PATHS` or it will be 401'd exactly like the Paymob one (H3).

### LOW

- **`ADMIN_SESSION_SECRET` is set but dead** — delete it from `.env`, `.env.example:16`, and PROJECT.md, and correct the comment to say admin sessions are opaque DB-backed tokens.
- **`next.config.ts:5` hardcodes personal LAN IPs** in `allowedDevOrigins: ["192.168.1.42","192.168.1.61"]` (dev-only, harmless in prod). Same pattern in `scripts/capture-tour-screenshots.ts` and `public/onboarding-tour/README.md`.
- **Lint is non-gating in both workflows and `pr.yml`'s unit step cannot pass** (no Postgres service, no `DATABASE_URL`, and `tests/setup.ts:4` throws unconditionally). Verified lint state: **133 problems (42 errors, 91 warnings, 35 auto-fixable)** — the "194-error backlog" cited in both workflow comments is stale by ~5×. The one `no-restricted-imports` error is the live BYPASSRLS violation in `lib/demo/clone-tenant.ts:16`.
- **Four npm-reachable scripts TRUNCATE the entire database with no safety gate** (`db:seed`, `db:seed:rich`, `db:seed:three`, plus un-aliased `scripts/e2e-onboarding.ts`). `tests/isolation.test.ts` learned this lesson with a two-condition guard; it was never backported. `scripts/seed-showcase.ts` and `seed-heavy-test.ts` are hardcoded to a real account (`samyamr819@gmail.com` / tenant `elhenawystore`).
- **Five dead Firebase scripts** crash on import (`firebase` is not a dependency; they parse a nonexistent `.env.local`). Delete them.
- **`middleware.ts` is on the deprecated side of the Next 16 `middleware`→`proxy` rename.** Not a current break, but the migration is not rename-only: `proxy` runs on the **Node** runtime with no Edge option, which changes the runtime semantics this entire gate chain was written against. Plan it deliberately.
- **A verbatim copy of `.env` sits at `.next/standalone/.env`** (Next copies it during build). The Docker path is **safe** — verified `.dockerignore` excludes `.git`, `.next`, `.env`, `.env.*` (with `!.env.example`), so nothing is baked into the image. The risk is any non-Docker deploy (rsync/scp/CI artifact). Delete the stale artifact and keep `.next/` out of any deploy exclusion list.
- **Doc drift to correct:** PROJECT.md documents `/sales/[id]`, `/cash-shifts`, `/settings/cash-drawer`, `lib/repo/cash-shifts.ts`, and an `/api/cash-shifts` group — none exist; it says 39 migrations (46) and 169 routes (163); §20 says the trial gate is skipped (it is live). README says "Deployment: Not yet wired" and omits ~15 shipped subsystems. `DEPLOYMENT_READINESS.md` says 39 migrations and claims PR CI runs i18n tests. `infra/pre-pentest-audit.md` documents a `pwd.reset 10/1h/actor` bucket that does not exist and the old `matgary.local` sender. Spec H03 describes `TotpRequiredError`/`InvalidTotpError` and a `/login/2fa` page that were never built.

### Explicitly disproven — do not spend effort here

Three findings from the audits did **not** reproduce against the tree:

1. **"The repo does not typecheck; `lib/notifications/dispatch.ts` has a blocking TS2322."** False. `npx tsc --noEmit` from a clean tree exits 0. Line 194 already reads `kind: EVENT_NOTIFICATION_KIND[eventType]`. (Local typecheck *is* non-deterministic — `tsconfig` `include` covers `.next/types/**` with `incremental: true`, so always `rm -f tsconfig.tsbuildinfo` first. CI has no `.next`, so CI is deterministic.)
2. **"`tests/mail-password-reset.test.ts` fails 2/5 on the Matgary→TheStoro rebrand."** False — verified 5 passed.
3. **"`ADMIN_IP_ALLOWLIST` / `CSP_ENFORCE` / `NEXT_PUBLIC_APP_URL` are build-time-inlined and unfixable at runtime in Docker."** False for all three. The compiled edge chunk retains literal `process.env.ADMIN_IP_ALLOWLIST` / `process.env.CSP_ENFORCE` reads, and `.next/server/chunks/_0uyg704._.js` retains `process.env.NEXT_PUBLIC_APP_URL??"http://localhost:3000"`. Turbopack inlines `NEXT_PUBLIC_*` only into **client** bundles. All three are runtime-fixable via `env_file`; the two module-scope reads need a container restart, not a rebuild.

Also note the audits disagreed on whether `PAYMOB_*` and `CRON_SECRET` are populated. Verified: all four `PAYMOB_*` are **present but empty** (billing correctly fail-closed today); `CRON_SECRET` is a strong 64-char value; `ADMIN_IP_ALLOWLIST` is empty.

---

## 8. Open questions for the operator

1. **What are the real values for the six secrets that must be regenerated before first boot** — `AUTH_SECRET`, `SECRET_KEY` (independent of each other), `POSTGRES_PASSWORD`, the `matgary_app` role password, `ADMIN_DB_PASSWORD`, and a Redis `requirepass`? And has anything been encrypted with the current placeholder `SECRET_KEY` yet (run the `v1:%` count in B9) — i.e. is rotation free or does it need a re-encryption pass?
2. **Where does the app run relative to compose** — inside it (`--profile app`, `CRON_TARGET_URL=http://app:3000`) or on the host with compose supplying only infra? Everything from the cron sidecar's `extra_hosts` to `ADMIN_DATABASE_URL` to nginx's `proxy_pass` target depends on the answer, and `.env` and `.env.example` currently disagree.
3. **Cloudflare posture:** orange-cloud (proxied) or grey? Which SSL/TLS mode? Cloudflare Origin CA or Let's Encrypt? Will you restrict origin ingress to Cloudflare's IP ranges, and will you enable Authenticated Origin Pulls? Nothing works safely until this is decided.
4. **Is the platform-admin plane meant to be internet-reachable at all?** If yes, `ADMIN_IP_ALLOWLIST` needs real CIDRs (IPv4 only — the matcher rejects IPv6, so force IPv4 egress or add v6 support first) and the `x-admin-bypass` escape hatch needs an audit row or deletion. If no, consider a VPN/Cloudflare Access tunnel and skip the header gymnastics entirely.
5. **Is billing going live at launch?** If yes, H3's four fixes (public path, empty-string guard, HMAC tenant binding, unique txn index) are prerequisites, and someone must decide the trial length — `TRIAL_DAYS = 30` is enforced while every piece of copy (typed catalog and DB seed) advertises 14 days.
6. **Which is the canonical sender identity** — Matgary or TheStoro, `thestoro.com` or a send subdomain? `lib/mailer.ts` defaults to `thestoro.com`, `.env.example` says Matgary, `infra/pre-pentest-audit.md` says `matgary.local`. Pick one before verifying the domain in Resend. Related: do you want replies to reach `support@`? If so, `SendInput` needs a `replyTo` field (2-line change).
7. **Are staff accounts (non-owner roles) going to exist on day one?** If yes, H2 is a hard blocker, not a high — a cashier can delete the catalog via the API. If launch is owner-only, it can ship as a fast-follow.
8. **What is the acceptable RPO/RTO?** That determines whether nightly `pg_dump` to R2 is sufficient or you need WAL archiving / PITR, and it should drive the restore-drill cadence.
9. **What happens to a tenant whose trial expires with Paymob unconfigured?** Today the middleware gate hard-locks them out of their own data at `/billing` with a "contact us" message and no self-serve path — is that the intended v1 behaviour, or should the gate soften to a banner until billing is live?
10. **Do you want the `/reports` and `/activity` pages reachable?** Both exist, both are gated, and neither appears in the sidebar or mobile nav. `/whatsapp` is desktop-only.
11. **Is the notification/digest subsystem in scope for launch?** `fanoutEvent` is dead code, there is no preferences UI, no drain cron, `digest_settings.email_fallback` is editable-but-unread, and the digest cannot send under a correctly-configured DB (H4). Either finish it or hide the settings surfaces so operators don't enable features that do nothing.
12. **Who gets paged, and on what channel?** There is no alerting implementation anywhere in the repo. At minimum: `/readyz` external check, disk-full, backup-staleness, and `SENTRY_DSN`.