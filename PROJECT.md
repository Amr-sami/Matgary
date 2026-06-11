# Matgary — Project Reference

A complete, single-document map of the codebase. Use it as the index when you need to find where something lives, how it's wired, and why it's shaped the way it is.

> The package name in `package.json` is `cornerstore` (the original Corner Store
> single-shop app it grew out of). Everywhere else it's called **Matgary** —
> Arabic for "my store". Same product.

---

## 1. What this is

A **multi-tenant POS / inventory / ERP SaaS** for small retailers (originally watches, perfumes, sunglasses — now generic). Each signed-up shop is one **tenant**: its own catalog, sales, customers, expenses, suppliers, WhatsApp creds, team, branches. Data is segregated in **one shared PostgreSQL database** via two enforcement layers:

1. **App-level filtering** — every query carries `tenant_id`.
2. **Row-Level Security (RLS)** in Postgres — `app.tenant_id` session var is set at the start of every transaction (`withTenant`) and policies on every table reject reads/writes for any other tenant. RLS is the **safety net**, not the primary mechanism.

The app runs as a Node.js Next.js server on Postgres, with optional Redis for cache + rate limits, and optional Sentry. WhatsApp Cloud API + Green API integrations are baked in. A separate **platform admin** area (`/admin/*`) exists alongside tenants for godmode operations (suspend tenants, broadcasts, plans, audit log) — protected by its own auth, IP allowlist, BYPASSRLS DB role, and ESLint guard preventing tenant routes from importing admin code.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Runtime | **Node.js 20+**, **Next.js 16** (App Router, Turbopack), **React 19.2** |
| Language | **TypeScript 5** (strict), bundler module resolution, `@/*` path alias to project root |
| Styling | **Tailwind CSS 4** (PostCSS plugin), Cairo + Tajawal + Lemonada via `next/font/google` |
| Database | **PostgreSQL 16** + **Drizzle ORM 0.45** (postgres-js client) |
| Auth | **Auth.js v5 (next-auth beta)** — Credentials provider, JWT sessions, bcryptjs, TOTP 2FA, `@auth/drizzle-adapter` |
| Cache / RL | **Redis 7** (ioredis) — opportunistic, app degrades to direct Postgres if down |
| Jobs | **BullMQ** — backed by Redis |
| Mail | **nodemailer** (logs to console if SMTP_HOST unset) |
| WhatsApp | **WhatsApp Cloud API** (per-tenant OAuth) + legacy **Green API** (AES-256-GCM at rest) |
| Validation | **zod 4** |
| PDF | `pdf-lib` + `@pdf-lib/fontkit` (Arabic-shaped receipts) + `qrcode` |
| Charts | `recharts` |
| Drag-drop | `@dnd-kit/*` |
| Offline cache | `dexie` (IndexedDB) |
| Icons | `@phosphor-icons/react` (centralised through `lib/icons.ts`) |
| Observability | `@sentry/nextjs` (gated on `SENTRY_DSN`) |
| Testing | **Vitest** (unit + isolation suite), **Playwright** (e2e) |
| Container | **Docker Compose** for Postgres + Redis + nightly pg_dump; multi-stage Dockerfile (`output: "standalone"`) |
| CI | GitHub Actions — `pr.yml` (typecheck + lint + cache tests) and `main.yml` (full isolation suite) |

Build is the standard `next build` with **standalone output** so the production Docker image stays small (~280 MB).

---

## 3. Top-level layout

```
matgary/
├── app/                  Next.js routes (UI + API)
├── apps/                 Reserved for future split-out apps
├── backups/              Mounted host dir for nightly pg_dump
├── components/           UI components (cream/gold Corner Store theme)
├── dictionaries/         i18n JSON — ar.json, en.json
├── docs/                 Specs (incl. platform-admin-dashboard.md)
├── hooks/                Client React hooks (data fetching wrappers)
├── infra/                Docker init SQL, backup/restore scripts
├── lib/                  Server-side core (auth, db, repo, validators, utils)
├── public/               Static assets
├── scripts/              tsx CLI scripts (seed, inspect, e2e helpers)
├── specs/                Additional spec documents
├── tests/                Vitest unit + isolation, Playwright e2e
├── uploads/              Mounted host dir for tenant-uploaded files
├── middleware.ts         Edge middleware (auth, i18n, CSP, admin gate)
├── instrumentation.ts    Sentry hook
├── drizzle.config.ts     Migrations config
├── docker-compose.yml    Postgres + Redis + nightly backup
├── Dockerfile            Multi-stage build for production image
├── next.config.ts        standalone output, postgres external
├── playwright.config.ts  e2e
├── vitest.config.ts      unit + isolation
├── sentry.*.config.ts    Three Sentry configs (client / server / edge)
├── package.json
├── tsconfig.json
├── plan.md               (Historical plan)
├── task.md               Live engineering backlog (gap completion)
├── FEATURE_IDEAS.md      Idea staging
├── README.md             Setup + commands
├── AGENTS.md             ⚠ "This is NOT the Next.js you know" — read node_modules docs
└── CLAUDE.md             Imports AGENTS.md
```

> ⚠ **AGENTS.md / CLAUDE.md tell agents to read `node_modules/next/dist/docs/`
> before writing code.** Next 16 has breaking changes vs. training-data Next 14/15.

---

## 4. Routing — `app/`

App Router. Two route trees:

### 4.1 Pre-login, internationalised — `app/[lang]/`

Locale-prefixed pages live under `/ar/*` and `/en/*`. The middleware redirects bare visits (e.g. `/welcome`) to the resolved locale prefix.

```
app/[lang]/
├── (auth)/         signup, login, forgot-password, reset-password, onboarding
├── (marketing)/    welcome, about, contact, blog, help, status, terms, privacy
├── layout.tsx      Nested DictionaryProvider (locale from URL wins)
└── welcome/
```

### 4.2 Post-login app — `app/`

Logged-in pages are flat (no `[lang]` prefix — `<html lang dir>` is set on the root layout from session locale or cookie). Each route renders inside `components/layout/AppShell.tsx`.

| Surface | Pages |
|---|---|
| Sales / POS | `/` (dashboard), `/sales`, `/sales/[id]`, `/add-product`, `/returns` |
| Inventory | `/inventory`, `/preview/errors` |
| Buying | `/purchases`, `/suppliers`, `/suppliers/[id]` |
| Money | `/expenses`, `/cash-shifts`, `/cash-shifts/[id]`, `/billing` |
| CRM | `/customers`, `/customers/[phone]` |
| People | `/team`, `/leave`, `/tasks`, `/activity` |
| Insights | `/insights`, `/reports` |
| Comms | `/whatsapp` |
| Account | `/account/security`, `/account/change-password` |
| Settings | `/settings`, `/settings/branches`, `/settings/cash-drawer`, `/settings/digest` |
| Suspended | `/service-paused` (redirect target when tenant is suspended) |
| Probes | `/healthz`, `/readyz` |
| Errors | `app/error.tsx`, `app/global-error.tsx`, `app/not-found.tsx` |

### 4.3 Platform admin — `app/admin/`

Separate authn (cookie session, password rotation, sign-out-everywhere), IP allowlist, separate Postgres role with BYPASSRLS.

```
app/admin/
├── login/, account/, admins/, audit/, broadcasts/, plans/,
├── sales/  (overview + per-tenant drill-down)
└── tenants/, tenants/[id]
```

### 4.4 Root layout — `app/layout.tsx`

Wires the whole tree together:

- Reads `x-locale` header (set by middleware) → drives `<html lang dir>`
- Loads dictionary for that locale at the root (nested `[lang]/layout.tsx` shadows it on pre-login pages)
- Reads non-HttpOnly `mg.branch_name` cookie → passes to `ActiveBranchNameProvider` so the sidebar renders the correct store heading on the **first byte of SSR** (no flicker after hydration)
- Renders the **app splash** (`#app-splash`) — plain HTML+CSS overlay, shown until `window.load`, hidden by a `next/script beforeInteractive` injected script
- Mounts the provider chain:
  ```
  SessionProvider
    → IconProvider
      → DictionaryProvider
        → ActiveBranchNameProvider
          → {children}
  ```

---

## 5. Middleware — `middleware.ts`

Single edge middleware does **everything that has to happen on every request**:

1. **Locale resolution** (`x-locale` header for the layout):
   URL path locale > session user.locale > `NEXT_LOCALE` cookie > default `ar`.
2. **Localised redirects** for the pre-login routes (`/welcome` → `/ar/welcome`, etc).
3. **Auth gate** via `NextAuth(authConfig).auth` — non-public paths redirect to login.
4. **CSP** per-request nonce. Defaults to **Report-Only**; flip with `CSP_ENFORCE=1`. `style-src` still allows `'unsafe-inline'` for Tailwind 4 (backlog item).
5. **Security headers**: `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy: camera=(), microphone=(), geolocation=(self)`.
6. **Platform admin gate** — separate path tree (`/admin/*`, `/api/admin/*`), separate cookie, IP allowlist with `x-admin-bypass` escape hatch, public paths handled by `lib/admin/middleware.ts`. Tenant routes never see admin cookies and vice-versa.

The middleware is intentionally **fat** — keeping all gatekeeping logic in one file is easier to audit than scattering it across layouts.

---

## 6. Data layer — `lib/db/`

```
lib/db/
├── index.ts          Drizzle client + withTenant() helper
├── schema.ts         All tables, relations, types (2091 lines)
├── migrate.ts        Migration runner (uses DATABASE_URL = admin role)
└── migrations/       0000_… → 0038_…
    └── meta/         Drizzle journal — UPDATE meta/_journal.json by hand
                      when adding a hand-written SQL migration.
```

### 6.1 Two Postgres roles, one database

- `matgary` — superuser, owns the schema, used **only** by migrations.
- `matgary_app` — `NOSUPERUSER NOBYPASSRLS`, used by the running app.
  This is what makes RLS effective.
- `matgary_admin` — `BYPASSRLS`, used **only** by `/admin/*` routes via `ADMIN_DATABASE_URL`. ESLint guard prevents tenant code from importing `lib/admin/*`.

Init SQL: `infra/init-postgres.sql` (runs on fresh container).

### 6.2 `withTenant(tenantId, fn)`

```ts
export async function withTenant<T>(tenantId, fn) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
```

Every tenant-scoped data access goes through this. App code **still filters by `tenant_id` explicitly** — RLS is the safety net.

### 6.3 Schema map

All tables live in `lib/db/schema.ts`. Grouped by domain:

| Domain | Tables |
|---|---|
| **Auth (global)** | `users`, `accounts`, `sessions`, `verificationTokens` |
| **Tenancy** | `tenants`, `tenantMembers`, `tenantDeletions` |
| **Catalog** | `categories`, `categoryAttributes`, `categoryAttributeValues`, `brands`, `products`, `productAttributeValues`, `productHistory` |
| **Operations** | `sales`, `salePayments`, `returns`, `expenses`, `customerWallets`, `customerWalletEvents` |
| **Purchasing** | `suppliers`, `purchaseOrders`, `purchaseOrderItems`, `purchaseOrderPayments` |
| **Cash** | `cashShifts`, `cashMovements` |
| **People** | `attendanceEvents`, `attendanceSettings`, `employeeCompensation`, `payrollPeriods`, `leaveRequests`, `tasks` |
| **Multi-store** | `branches`, `storeLocations` |
| **Settings & UX** | `shopSettings`, `notifications`, `activityLogs` |
| **WhatsApp** | `waConnections`, `waContacts`, `waConversations`, `waMessages`, `waTemplates`, `waWebhookEvents` |
| **Billing** | `subscriptions`, `paymentAttempts` |
| **Digest** | `digestSettings`, `digestRuns` |
| **Platform admin** | `admins`, `adminSessions`, `adminPasswordHistory`, `adminAuditLog`, `platformPlans`, `platformBroadcasts` |

### 6.4 Migrations

- Generated with `npm run db:generate` (Drizzle infers from `schema.ts`).
- Hand-written SQL migrations (RLS policies, partial indexes, backfills) **must** be registered in `lib/db/migrations/meta/_journal.json` by hand — Drizzle won't pick them up otherwise.
- Apply with `npm run db:migrate` (tsx runner, uses admin URL).
- 39 migrations as of 0038 (`sale_payments` ledger).

### 6.5 Key data patterns

- **`amountPaid` + `salePayments` ledger** — partial payments. `sales.amountPaid` is the current balance; every payment event (initial/cash/instapay/card) appends to `sale_payments` so the customer detail page can render a payment timeline.
- **Branch cookies** — `mg.branch` is HttpOnly (auth); `mg.branch_name` is non-HttpOnly companion (UI hint for SSR rendering of the sidebar heading without a flicker).
- **Drizzle raw-SQL pitfalls**:
  - Arrays unpack to first element only — use `sql.join` with `IN (…)` for arrays.
  - JS `Date` serialises via `toString()`, not ISO — call `.toISOString()` and cast with `::timestamptz`.

---

## 7. Auth — `lib/auth.ts` + `lib/auth.config.ts`

- **`authConfig`** (edge-safe) — used by `middleware.ts`. No DB imports.
- **`auth.ts`** (Node-runtime) — full Auth.js v5 setup:
  - Drizzle adapter
  - Credentials provider with email/username + password + optional TOTP
  - JWT sessions
  - User-context cache: membership + permissions + onboarding + locale resolved once per minute (`userContextKey`), busted explicitly on mutation via `bustUserContextCache(userId)`
  - **Login rate limits**: IP (10 / 15min) + email (5 / 15min) + TOTP (5 / 15min)
  - **Token-version invalidation** — `users.tokenVersion` bumped on password change, 2FA toggle, "sign out everywhere". JWTs carry `tv`; the session callback rejects mismatches.
  - Synthetic identifiers — staff log in as `username@tenant-slug` (no TLD).
  - Identifier normalisation strips invisible chars (zero-width-space, RLM/LRM, BOM) — mobile keyboards love to insert them.
  - **2FA flow** — UI pre-checks `/api/auth/2fa-needed` before submitting password, then includes TOTP on the credentials POST.
  - **Impersonation** — admin can mint a session as an owner via `lib/admin/impersonation.ts`; session carries an `impersonation` block; `AppShell` shows a red banner.

### Permissions — `lib/permissions.ts`

A flat `Permission` string union:

- View: `view_dashboard`, `view_inventory`, `view_sales`, `view_customers`, `view_expenses`, `view_returns`, `view_insights`, `view_settings`, `view_suppliers`, `view_purchases`
- Manage: `manage_inventory`, `record_sales`, `modify_sales`, `manage_returns`, `manage_expenses`, `manage_catalog`, `manage_suppliers`, `manage_purchases`, `manage_whatsapp`, `manage_team`
- HR / ops: `attendance_self_manual`, `manage_tasks`, `request_leave`, `manage_leave`, `view_activity_log`, `open_close_shift`, `manage_cash_reconciliation`, `manage_digest_settings`

Owner role implicitly has every permission. Helpers: `can(principal, perm)`, `canAny(principal, perms[])`. Sidebar visibility filters on these. **Server routes must re-check** — UI gating is not security.

---

## 8. Server-side core — `lib/`

```
lib/
├── auth.ts, auth.config.ts        Auth.js
├── permissions.ts                 Permission catalog + helpers
├── db/                            Drizzle (see §6)
├── repo/                          Server-only data access
├── api/                           Client-side fetch wrappers
├── admin/                         Platform admin internals (forbidden import)
├── i18n/                          Locale config, dictionary loader
├── cache.ts, redis.ts             Opportunistic Redis cache
├── ratelimit.ts                   Redis-backed token bucket
├── crypto.ts                      AES-256-GCM for Green API token
├── totp.ts                        Base32 secret + recovery codes
├── mailer.ts, mail/               Nodemailer + templates
├── notifications/                 In-app notification events
├── icons.ts                       Centralised icon re-exports
├── logger.ts                      Logging helper
├── pdfReceipt.ts                  Receipt PDF (pdf-lib + Arabic shaping)
├── receipt-strings.ts             Receipt copy
├── plans.ts                       Subscription tiers
├── payments/                      Paymob (skipped until provider ready)
├── csv.ts, csvImport.ts           Bulk imports
├── uploads.ts                     Team avatar / file uploads
├── settings.ts, settings.defaults.ts
├── activity-labels.ts             "Who did what" feed labels
├── url-safe.ts                    Open redirect guard
├── broadcasts.ts                  Platform-wide announcements
├── whatsapp.ts, whatsapp/         Green API + Cloud API wrappers
├── cron/, digest/                 Daily owner digest, cron tasks
├── seeds/cornerstore.ts           Corner Store preset
├── sentry/scrub.ts                Strip credentials before Sentry send
├── validators/egypt.ts            Egyptian phone validation
└── utils.ts, utils/slug.ts        Misc helpers
```

### 8.1 `lib/repo/` — data access

The only place tenant-scoped DB calls live. Each file is a domain module:

```
account-security.ts   attendance.ts        attendance-events.ts
branches.ts           cash-shifts.ts       catalog.ts            catalog-admin.ts
customers.ts          digest.ts            digest-runs.ts        insights.ts
leave-requests.ts     loyalty.ts           notifications.ts      operations.ts
password-reset.ts     payroll.ts           payroll-compute.ts    product-import.ts
purchase-orders.ts    purchase-payments.ts sale-discounts.ts     settings.ts
subscriptions.ts      suppliers.ts         tasks.ts              team.ts
tenant-deletion.ts    activity.ts
```

Every function takes `tenantId` and calls `withTenant(tenantId, async (tx) => …)`. Route handlers are thin — they validate input with zod and call into here.

### 8.2 `lib/api/` — client-side fetch wrappers

Typed wrappers used by hooks (e.g. `lib/api/sales.ts`, `lib/api/products.ts`). They post JSON, handle errors, and return shaped data. Hooks in `hooks/*` are typically just a `useEffect` + `useState` + one of these.

### 8.3 i18n — `lib/i18n/` + `dictionaries/`

- Locale config: `lib/i18n/config.ts` — `["ar", "en"]`, default `ar`, dir helper.
- Detection: `lib/i18n/detect.ts` — URL > session > cookie > default.
- Dictionary loader: `lib/i18n/get-dictionary.ts` — dynamic import of `dictionaries/{ar,en}.json`.
- Format helpers: `lib/i18n/format.ts` — currency, numerals.
- Provider: `components/i18n/DictionaryProvider.tsx` — React context; nested `[lang]/layout.tsx` shadows the root provider so pre-login pages always see the URL-derived locale.

---

## 9. UI — `components/`

### 9.1 Primitives — `components/ui/`

`Button`, `Input`, `Select`, `FilterSelect`, `Modal`, `ConfirmDialog`, `Tabs`, `Toast`, `Badge`, `Skeleton`, `PageSkeleton`, `Pagination`, `EmptyState`, `LoadingSpinner`, `PasswordInput`, `UserText`.

### 9.2 Layout — `components/layout/`

`AppShell.tsx`, `Sidebar.tsx`, `Header.tsx`, `MobileBottomNav.tsx`, `UserMenu.tsx`, `ActiveBranchProvider.tsx` (context for the SSR-stable store heading).

### 9.3 Domain folders

```
add-product/   admin/        branches/    brand/      broadcasts/
cash-shifts/   customers/    dashboard/   expenses/   feedback/
i18n/          insights/     inventory/   landing/    leave/
notifications/ offline/      purchases/   reports/    returns/
sales/         settings/     suppliers/   tasks/      team/
whatsapp/
```

Each folder owns the components that render its surface(s) + any modals it triggers (e.g. `customers/InvoiceSettleModal.tsx`).

### 9.4 Shared contexts

- `components/settings-context.tsx` — tenant settings (shop name, currency, etc).
- `components/catalog-context.tsx` — categories / brands / attributes cache.
- `components/IconProvider.tsx` — sets phosphor-icons weight/colour defaults.

### 9.5 Theming + fonts

Tailwind 4 with the original Corner Store cream/gold palette. Three Google fonts via `next/font`:
- **Cairo** (`--font-cairo`) — body
- **Tajawal** (`--font-display`) — display headlines
- **Lemonada** (`--font-catchy`) — accent display

Logo (`components/brand/Logo.tsx`) is live text — the wordmark "متجري / MATJARI" inherits text color from the parent.

### 9.6 Hydration discipline (React 19)

- `suppressHydrationWarning` only silences **content** mismatches (text, attrs). Structural mismatches (extra/missing nodes) are recoverable errors. Pattern: render the same DOM tree on server and client, toggle visibility with `hidden` class.
- Inline `<script>` JSX children are silently skipped — use `next/script strategy="beforeInteractive"`.
- Never `removeChild` a node React owns (e.g. the splash) — it will throw `NotFoundError` on the next commit. Park it with `visibility:hidden` instead.

---

## 10. Client hooks — `hooks/`

Pattern: each file exports a `useX()` that fetches via `lib/api/x.ts`, caches results, exposes mutate helpers.

```
useBranches.ts         useBrands.ts         useCashShift.ts
useCategories.ts       useCategoryAttributes.ts useCustomersData.ts
useExpenses.ts         useInsights.ts       useLeaveRequests.ts
useLeaveUnread.ts      useNotifications.ts  useOffline.ts
useProducts.ts         usePurchaseOrders.ts useReturns.ts
useSales.ts            useScrollReveal.ts   useSearch.ts
useShopSettings.ts     useSuppliers.ts      useTasks.ts
useUnreadTaskCount.ts
```

`useBranches.ts` uses a **localStorage cache + atomic single-`setState`** to prevent flicker (the `mg.branch_name` cookie ensures SSR also gets a value).

---

## 11. API routes — `app/api/`

169 route handlers, grouped:

- **account/** — 2FA enroll/disable, change password, delete + cancel, email check, export data, locale set, store handle, revoke sessions
- **activity/** — paginated activity feed
- **admin/** *(godmode, gated)* — overview, sales, plans, tenants, broadcasts, impersonation, audit
- **attendance/** — events, locations, payroll, self check-in, settings
- **attribute-values/**, **attributes/**, **brands/**, **categories/** — catalog admin
- **auth/** — Auth.js handler + 2FA-needed check
- **billing/** — Paymob webhook + subscribe + cancel + status (currently no-op until provider ready)
- **branches/** — list, create, update, select-active
- **broadcasts/** — current platform announcement
- **cash-shifts/** — open, close, force-close, movements, review, current
- **cron/** — scheduled tasks (activity log cleanup, admin session cleanup, cash shift sweep, daily digest, recurring expenses, tenant deletion)
- **customers/** — by-phone lookup, credit, mark-all-paid, payments, wallet
- **digest/** — settings, history, preview
- **expenses/**, **insights/**, **leave-requests/**, **notifications/**, **plans/**, **pos/bootstrap**, **products/** (+ bulk + import + adjust + history)
- **purchase-orders/** — list, create, receive, cancel, payments
- **returns/**, **sales/** (+ bulk + cart + invoice paid + settle), **settings/**, **suppliers/**, **tasks/**, **team/** (+ compensation + password + test-login), **uploads/team/**
- **whatsapp/** — Cloud API send + templates + OAuth + webhook, conversations, otp/send, legacy send-pdf

Each handler imports from `lib/repo/*`, validates input with zod, returns `NextResponse.json(…)`. Errors return `{ error: "CODE", detail?: "..." }`.

---

## 12. Branch / store name flicker fix (worth knowing)

A subtle multi-layer issue, recently solved — pattern is reusable:

1. **`mg.branch_name` non-HttpOnly cookie** — set whenever branch is selected. Root layout reads it server-side → renders sidebar heading on first byte.
2. **`ActiveBranchNameProvider`** wraps the tree with that cookie value.
3. **`useBranches`** uses a `localStorage` seed + a single atomic `setState` for the post-hydration update.
4. **DOM stable across SSR/CSR** — always render `<p>` for the tenant subtitle, toggle with `hidden` class.
5. **Splash overlay** in `app/layout.tsx` masks any residual reflow; hidden after `window.load` by a `next/script` injected early.

---

## 13. Cash, payments, receivables (recent work)

- `0037_sales_partial_payments.sql` adds `amount_paid` and `partial_paid_at` columns + CHECK constraint + partial index.
- `0038_sale_payments.sql` adds a payment-event ledger (one row per event: `cash | instapay | card | initial`).
- `/api/sales/settle` accepts `invoiceIds[]`, applies an amount, stamps cash-shift `paid_in` movements, writes a `sale_payments` row, updates `sales.amount_paid` + `is_paid`.
- `components/customers/InvoiceSettleModal.tsx` is the partial-pay UI on the customer detail page.
- The receivables list on `/customers` is **preview-only** — clicking a debtor goes to `/customers/[phone]` where payments are managed.

---

## 14. Tests

```
tests/
├── isolation.test.ts          The load-bearing safety net — tenant A
│                              cannot read/write tenant B's anything,
│                              and RLS hides every row when app.tenant_id
│                              is unset.
├── cache.test.ts              Redis cache helpers
├── ratelimit.test.ts          Token bucket
├── egypt-phone.test.ts        Phone validator
├── i18n-config.test.ts        Locale helpers
├── mail-password-reset.test.ts
├── url-safe.test.ts           Open-redirect guard
├── repo/                      Repo-layer unit tests
├── e2e/                       Playwright specs
└── setup.ts                   Vitest setup
```

Run: `npm test`, `npm run test:watch`, `npm run test:e2e`, `npm run test:e2e:headed`.

---

## 15. Scripts — `scripts/`

CLI helpers, all `tsx`:

- `seed-test-user.ts` — seed a working tenant + user
- `seed-heavy-test.ts`, `verify-heavy-seed.ts` — large dataset
- `seed-showcase.ts` — demo data
- `reset-employee.ts`, `check-password.ts` — admin escape hatches
- `save-greenapi-creds.mjs` — store WhatsApp creds
- `inspect-sale.mjs`, `inspect-settings.mjs`, `probe-customers.mjs`, `test-aggregation.mjs` — debugging probes
- `e2e-auth.mjs`, `e2e-team.mjs`, `e2e-onboarding.ts` — scripted flows

`scripts/` is **excluded from `tsconfig.json`** so it doesn't affect typecheck.

---

## 16. Infra & deploy

- **Docker Compose** (`docker-compose.yml`): Postgres 16-alpine (`5434:5432` to dodge collisions), Redis 7-alpine (`6381:6379`), nightly `backup` sidecar (pg_dump + retention to `./backups`).
- **Init SQL** (`infra/init-postgres.sql`): creates `matgary_app` NOSUPERUSER role + grants. If you nuke the volume, it runs again.
- **Backup / restore** (`infra/backup.sh`, `infra/restore.sh`): scheduled by the sidecar's BusyBox crond from `BACKUP_CRON`.
- **Dockerfile**: multi-stage, uses `next.config.ts` `output: "standalone"` → final image is the Node 20 alpine base + standalone bundle + public/static. ~280 MB.
- **Production deploy**: not yet wired. Requires managed Postgres with the same two roles + `AUTH_SECRET` + `SECRET_KEY` + a way to run `npm run db:migrate` on deploy.

---

## 17. CI

- `.github/workflows/pr.yml` — typecheck (`tsc --noEmit`), informational lint, Redis-gated unit tests on every PR.
- `.github/workflows/main.yml` — full isolation suite against an ephemeral Postgres on every push to `main`.
- Branch protection should require `pr.yml` before merge (configure in repo settings).

---

## 18. Environment variables (`.env.example`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Admin role (migrations). |
| `APP_DATABASE_URL` | App role (RLS-enforced runtime). |
| `ADMIN_DATABASE_URL` | Platform-admin role (BYPASSRLS). |
| `ADMIN_DB_PASSWORD` | Password granted to `matgary_admin` on migrate. |
| `ADMIN_SESSION_SECRET` | 32-byte secret for admin session cookies. |
| `ADMIN_IP_ALLOWLIST`, `ADMIN_IP_ALLOWLIST_BYPASS_USER` | Lock the admin area. |
| `BOOTSTRAP_ADMIN_EMAIL` | First admin email (password is `12345678`, must rotate). |
| `AUTH_SECRET` | Auth.js JWT signing key. |
| `SECRET_KEY` | AES-256-GCM key for Green API token at rest. |
| `REDIS_URL`, `CACHE_DISABLED`, `CACHE_DEBUG` | Redis cache (optional). |
| `SMTP_*`, `MAIL_FROM` | Outbound email (logs to console if unset). |
| `SENTRY_DSN`, `SENTRY_TRACES_RATE`, `SENTRY_ENVIRONMENT` | Sentry (optional). |
| `CSP_ENFORCE` | `1` flips CSP from Report-Only to enforcing. |
| Paymob keys | Empty — billing/trial gate work is skipped until provider is ready. |

---

## 19. Conventions & gotchas

- **`@/*` alias** maps to project root. Imports use `@/lib/...`, `@/components/...`.
- **`pageextensions`**: only `.tsx` for pages, `.ts` for routes.
- **No `.md` files** unless explicitly requested — agents must not auto-generate planning docs.
- **No emojis in code/docs** unless explicitly asked.
- **Sidebar visibility** filters on permissions; **server routes must re-check**. UI gating is not security.
- **Hand-written migrations** must be registered in `_journal.json`.
- **`withTenant` is mandatory** for any tenant-scoped read or write — the explicit `tenant_id` filter is the primary line; RLS is the safety net.
- **Hooks must not bypass `withTenant`** — they go through API routes, not Drizzle directly.
- **Receipt PDFs**: Arabic shaping needs `@pdf-lib/fontkit` registered on the document; missing this produces visually-correct-looking but search-broken text.
- **Phone numbers**: Egyptian-only, normalised via `lib/validators/egypt.ts`. National ID validation was **deliberately dropped** — don't propose adding it back.

---

## 20. Known-deferred items (don't propose unless asked)

These are deliberate decisions, not todos:

- **Paymob billing / trial gate** — provider keys empty until provider is ready.
- **Smart Payment Tracking** — auto-detect VF Cash / InstaPay needs a mobile SMS-forwarder app that doesn't exist yet.
- **CAPTCHA**, **EN display font**, **post-auth locale prefixes**, **pre-tenant email verification** — auth audit carry-forwards closed.
- **Strict CSP for styles** — Tailwind 4 injects inline styles without a nonce hook today; tracked in `task.md §4`.
- **Lint backlog** — 194-error backlog being worked through; lint stays non-gating in `pr.yml`.

---

## 21. Where to look when…

| Need to… | Open |
|---|---|
| Add a tenant-scoped table | `lib/db/schema.ts` → generate migration → register in `_journal.json` |
| Add a permission | `lib/permissions.ts` (catalog + label) + update sidebar + recheck on routes |
| Add a sidebar item | `components/layout/Sidebar.tsx` `primaryItems` / `secondaryItems` + dictionary labels |
| Add a route | `app/foo/page.tsx` for page, `app/api/foo/route.ts` for API |
| Add data access | `lib/repo/foo.ts` exporting functions that use `withTenant` |
| Add a client hook | `hooks/useFoo.ts` calling `lib/api/foo.ts` |
| Localise text | `dictionaries/{ar,en}.json` + use `useDictionary()` |
| Schedule a job | `app/api/cron/foo/route.ts` + register the cron externally |
| Add a Sentry breadcrumb | Already auto — credentials are scrubbed in `lib/sentry/scrub.ts` |
| Talk to WhatsApp | `lib/whatsapp/` (Cloud API), `lib/whatsapp.ts` (Green API) |
| Send mail | `lib/mailer.ts` + a template in `lib/mail/` |
| Add a setting | `lib/settings.defaults.ts` + `lib/repo/settings.ts` + UI on `/settings` |

---

## 22. Glossary

- **Tenant** — one shop / account. Owns everything.
- **Branch** — a physical store under a tenant. Multi-store tenants get a heading-level switcher.
- **Owner** — the tenant member with `role = "owner"`. Bypasses permission checks in-app (server still validates).
- **Staff / Cashier / Manager** — non-owner members; permissions explicit in `tenantMembers.permissions`.
- **`withTenant`** — the transaction wrapper that sets `app.tenant_id` so RLS works.
- **RLS** — Row-Level Security. The Postgres-side enforcement.
- **POS** — `/sales` page; the cashier flow.
- **Receivables** — outstanding customer balances on partially-paid invoices.
- **Z-report** — end-of-shift cash reconciliation (paid in / paid out / variance).
- **Digest** — daily owner email summarising the previous day.
- **Impersonation** — platform admin viewing the tenant app as the owner; banner shown.
