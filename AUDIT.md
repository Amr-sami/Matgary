# Matgary — Engineering Excellence Audit

**Auditor's stance:** Principal Engineer responsible for this codebase for the next five years.
**Brief:** Brutally honest. No inflated scores. Evidence-based.

**Codebase fingerprint** (evidence collected this session):

| Metric | Value |
|---|---|
| Lines of TS/TSX (src) | **83,922** |
| `app/` lines | 28,670 |
| `lib/` lines | 27,807 |
| `components/` lines | 24,094 |
| `hooks/` lines | 1,389 |
| `tests/` lines | **1,404** (1.7% test:source ratio) |
| Tables | 53 |
| Migrations | 39 |
| Indexes declared | 87 (schema) + 118 (raw SQL migrations) |
| API route handlers | 169 |
| Pages | 54 (22 Server, 32 Client) |
| Client components (`"use client"`) | **204 / 223 TSX files (91%)** |
| Server Actions | 1 |
| `Suspense` usages | 5 |
| `loading.tsx` files | **0** |
| `error.tsx` files | 1 (root only) |
| `useState` call sites | 752 |
| `useEffect` call sites | 135 |
| `useMemo` / `useCallback` | 138 |
| `: any` annotations | 13 |
| `as any` casts | 4 |
| `as unknown` casts | 42 |
| `@ts-ignore` / `@ts-expect-error` | 1 |
| `eslint-disable` comments | 32 |
| `TODO` / `FIXME` / `HACK` | 4 |
| `console.*` calls in src | 72 |
| `try / catch` blocks | 192 |
| zod-validated routes | 79 / 169 (47%) |
| Routes importing repo | 108 |
| Routes touching `lib/db` directly (bypassing repo) | 7 (of 24 `lib/db` importers) |

---

## 1. Code Quality

### What's good

- **One naming convention end-to-end.** `useFoo` hooks, `lib/repo/foo.ts` for data access, `lib/api/foo.ts` for the typed fetch wrappers, `app/api/foo/route.ts` for handlers, `components/foo/Bar.tsx` for UI. A new engineer can find any feature in <60 seconds.
- **Comments are unusually high-signal.** Almost every non-obvious decision carries a "why" comment with the failure mode that motivated it (Drizzle array unpacking, React 19 structural mismatch, removeChild crash, etc.). This is rare and it's the single biggest maintainability asset in the codebase.
- **Dead code and TODOs are nearly absent** (4 TODO/FIXME across 83 KLOC).
- **Conventions are predictable** — once you've read one route handler, you've read most of them (`requireTenant` → `resolveBranchFilter` → `lib/repo` → `logActivity`).

### What's not

- **`lib/db/schema.ts` is 2,091 lines** — every table, relation, RLS comment, and migration note in one file. Discoverability is fine while it stays sorted, but a 5-table feature change touches 200+ unrelated lines.
- **`lib/repo/operations.ts` is 1,552 lines** and is a **god module** — sales (list/get/record/cart/update/void/markPaid/markInvoicePaid/settle), returns, expenses (incl. recurring expense materialisation), bulk delete. The 16 public functions span four distinct domains.
- **`components/sales/SaleForm.tsx` is 1,394 lines, single component**, mixing cart state, customer autocomplete, discount math, receipt building, WhatsApp send, offline POS plumbing, print routing, and form layout. 6 `useEffect`s, 4 `fetch` calls inline.
- **`app/settings/page.tsx` is 1,584 lines** — a single client page rendering ten settings sub-surfaces.
- **`app/customers/[phone]/page.tsx` is 901 lines** — server data, derived maps, modals, three-state chips, payment timeline. Should be 3–4 colocated components.
- **5 of 14 oversized files are admin client shells** (BroadcastsClient, TenantDetailClient, AdminsClient, OverviewClient, PlansEditorClient) ranging 514–826 lines — the admin area is on the same trajectory as the tenant app: one client page per surface, all logic inlined.
- **Duplication: route handler authorisation boilerplate** is repeated 169 times (`const r = await requireTenant(); if (!r.ok) return r.response; …`). Easily factored.
- **`unused dependencies` scan**: every "suspect" dep is in use, but with **1 import each** for `dexie`, `@pdf-lib/fontkit`, `qrcode`, `date-fns`, `@dnd-kit/sortable`, `@dnd-kit/utilities`. None are dead, but they're all single-call dependencies that could be revisited (`date-fns` in particular when only one helper is used).
- **`console.*` calls (72)** are not all wrapped in `logger`. Several are in production paths.

### Code smells found

- **Mixed responsibility in `recordCartSale`** — does inventory check, line discount math, attribute snapshot lookup, cart persistence, cash-shift stamping, customer wallet write, loyalty earn, in one function with N inline product lookups (see Performance §6 — that's an N+1).
- **Long parameter lists** — `recordCartSale(tenantId, lines, options)` where `options` is 12+ fields including `branchId`, `paymentMethod`, `customerName`, `customerPhone`, `note`, `customDate`, `amountPaid`, `loyalty*`, `invoiceId`, …
- **Magic strings**: invoice id format `INV-${ts}${rnd}` and regex `/^[A-Za-z0-9_\-:.]{4,80}$/` are inlined in operations.ts and re-validated in the route — no shared constant.
- **Stringly-typed enums**: `paymentMethod` and `discountType` are `string` columns with code-side enums. No Postgres ENUM.

**Code Quality Score: 65/100** — High-signal comments and uniform conventions are doing most of the heavy lifting. A few god files are the entire reason this isn't 75+.

---

## 2. SOLID Audit

### S — Single Responsibility

- **Violated, severely.**
  - `lib/repo/operations.ts` = sales + returns + expenses + recurring expense cron. Split into `repo/sales.ts`, `repo/returns.ts`, `repo/expenses.ts`.
  - `components/sales/SaleForm.tsx` = cart UI + autocomplete + tax/discount math + WhatsApp send + print + offline plumbing.
  - `app/settings/page.tsx` = ten settings surfaces. Already supports tabs; each tab should be its own client component.
  - `middleware.ts` (367 lines) handles locale + auth + CSP + security headers + admin gate. Defensible as a single audit surface, but four concerns.

### O — Open/Closed

- **Mostly compliant** by repo-module convention: adding a new domain means a new `lib/repo/foo.ts` + `app/api/foo/route.ts` without touching anything else.
- **Permission catalog (`lib/permissions.ts`) is closed for modification by accident** — three places hardcode special-case logic per route (`/tasks`, `/team` in `Sidebar.tsx`); adding a similar carve-out means editing the sidebar, not the catalog. Smells like the catalog should carry a `routeOverride?: (principal) => boolean`.

### L — Liskov Substitution

- Negligible class hierarchy in the codebase (functional throughout). Drizzle row types are used as DTOs and transformed via mappers (`rowToSale`) — no substitution violations because there's no inheritance.

### I — Interface Segregation

- **Violated by the `options` mega-object in `recordCartSale` / `recordSale`.** Callers pass an opaque blob; helpers downstream pluck what they need but receive the whole thing. Split into `BillingOptions`, `BranchContext`, `CustomerContext`, `LoyaltyContext`.
- **`Session.user`** in `lib/auth.ts` is a 13-field mega-context — UI components import the whole session to read one field. Probably fine; the alternative (multiple contexts) costs more than it earns at this size.

### D — Dependency Inversion

- **Mixed.** The repo layer is a great abstraction over Drizzle — handlers depend on `lib/repo/*`, not on `drizzle-orm`. Good.
- **But 7 route handlers import `@/lib/db` directly** (`account/email/check`, `account/store-handle/check`, `auth/2fa-needed`, `customers/by-phone/[phone]/payments`, `insights/staff-performance`, `settings/cash-drawer`, `whatsapp/webhook/events/[id]/replay`). Two of those are RLS-sensitive (`insights/staff-performance`, `customers/by-phone/[phone]/payments`) — they hand-roll filtering instead of going through `withTenant`. **This is a bug class waiting to happen.**
- **No DI for external services** — `nodemailer`, Sentry, Redis are imported wherever needed. Acceptable at this size; revisit when introducing a second mail provider or queue.

### Top violations

1. `lib/repo/operations.ts` god module (SRP + ISP).
2. `components/sales/SaleForm.tsx` god component (SRP).
3. 7 route handlers reaching past `lib/repo` to `lib/db` (DIP, **safety-critical**).
4. `app/settings/page.tsx` god page (SRP).

**SOLID Compliance Score: 60/100**

### Recommended refactors

- **Split `operations.ts`** → `repo/sales.ts`, `repo/returns.ts`, `repo/expenses.ts`. ~1 day. Low risk (mechanical).
- **Convert the 7 direct-DB routes** to go through new repo functions. ~½ day. Eliminates a class of RLS-bypass bugs.
- **Extract from `SaleForm.tsx`** — `useCart()` hook, `<CartLineEditor>`, `<DiscountControls>`, `<ReceiptDispatcher>`. ~2 days. High impact on every future POS change.

---

## 3. Clean Code

- **Functions are mostly short**, but a handful breach 200 lines (`recordCartSale`, `settleCustomerPayment`, `markInvoicePaid`). They contain at least two natural extract points each.
- **Deep nesting** is rare — most repo functions follow `if-guard → mutate → return` and stay at depth 2.
- **Error handling is consistent**: `try/catch` returning `{error: "CODE", detail?: …}` JSON. 192 catch blocks across the repo. The recently-fixed settle flow showed the value of `detail` — the generic Arabic toast on the client was uselessly opaque until the server started returning the actual cause.
- **`console.*` in production code (72 sites)** undermines the `logger` abstraction. Several are in cron paths and the WhatsApp webhook — exactly where structured logs matter most for incident response.
- **Magic values**: hardcoded timeouts (`520ms` splash hold, `60s` user-context cache, `1.6s` breathe animation), rate-limit windows (`10/15min`, `5/15min`). Most have a comment explaining why. Tolerable.
- **Naming**: clean, English-side. The mix of Arabic UI strings and English code is well-managed via the dictionary; no `الفاتورة فارغة` strings drift into transport/log paths *most* of the time — but a few do (e.g. `recordCartSale` throws Arabic strings as `Error.message`, and the catch wrapper turns them into HTTP 500s rather than user-facing validation errors).

### Anti-patterns observed

- **Arabic strings used as exception messages** in `recordCartSale`. They become 500-class errors with Arabic `detail`. Should be coded enums (`OUT_OF_STOCK`, `WRONG_BRANCH`) with messages assembled in the route.
- **No `loading.tsx`** anywhere — entire client pages render skeletons in `useEffect`s instead of letting Suspense + streaming do it. This is the largest single missed opportunity in Next 16.

**Clean Code Score: 68/100**

---

## 4. Design Patterns

### What's in place

- **Repository pattern** — `lib/repo/*`, well-followed (162 of 169 routes go through it).
- **Adapter pattern** — `lib/whatsapp/*` wraps Cloud API and Green API behind a small surface (`sendViaWhatsAppCloud`, `sendViaGreenApi`).
- **Context pattern (React)** — `DictionaryProvider`, `SettingsProvider`, `CatalogProvider`, `ActiveBranchNameProvider`, `IconProvider`. Layered correctly (locale outside catalog outside settings).
- **Transaction-scoped tenant binding** — `withTenant(tenantId, async tx => …)` is the central abstraction and it's right.
- **Companion-cookie pattern** for SSR-stable UI hints (`mg.branch` HttpOnly + `mg.branch_name` non-HttpOnly). Recently introduced, well-explained, generalisable.

### What's missing

- **No service layer between routes and repos.** When business rules cross domains (sale → cash shift → customer wallet → notifications → activity log → digest), the route handler orchestrates. The POST `/api/sales` route is fine; the planned `/api/sales/settle` flow has six side effects in `settleCustomerPayment` itself. Pull cross-domain orchestration into `lib/services/` once you cross 3 routes that touch the same combo.
- **No event/queue pattern** despite `bullmq` being a dependency. It's used in 2 files. Notifications, digest, and WhatsApp webhooks are good fits for jobs but currently run inline.
- **No factory or strategy for payment methods** — every callsite branches on `paymentMethod === "cash" | "instapay" | "card" | "initial"`. Will hurt the day Paymob lands.
- **No discriminated-union result types** — most repo functions throw on failure. The settle flow uses `SettlementError` (good); generalise.

**Design Quality Score: 62/100**

---

## 5. Architecture

### Module boundaries

```
HTTP (app/api/*)
  ↓ depends on
auth (lib/auth.ts) ─── api/auth-helpers (lib/api/*)
  ↓ depends on
repo (lib/repo/*)
  ↓ depends on
db (lib/db/*) — withTenant + schema
```

**Tight in the right places.** Components and hooks never import `lib/db`, never import `drizzle-orm` (verified: 0 occurrences). The platform admin (`lib/admin/*`) is import-guarded by ESLint so tenant code can't reach it.

### Where drift is starting

- **`lib/admin/` is becoming a parallel `lib/repo/`** (admins, audit, broadcasts, plans, sales, tenants — 15 files). Justifiable because of the BYPASSRLS pool, but the duplication of patterns (e.g. `lib/admin/sales.ts` 627 lines vs `lib/repo/operations.ts` sales section) is structural debt.
- **`lib/whatsapp/` and `lib/whatsapp.ts`** coexist (folder for Cloud API, file for legacy Green API). Legacy file should be folded into the folder as `green-api.ts`.
- **Cron tasks** live in `app/api/cron/*` — fine for an HTTP-triggered cron, but they bypass the repo abstractions in 3 of 6 cases (`cash-shift-sweep`, `recurring-expenses`, `digest-tick`). Same risk as the 7 direct-DB routes.
- **God modules identified:** `operations.ts`, `SaleForm.tsx`, `settings/page.tsx`. Each blocks one or more domain owners from working in parallel.

### Circular dependencies

- None found in spot-checks. The unidirectional `app → lib → db` flow plus the import-guard for `lib/admin` keeps this clean.

### Leaking abstractions

- **Drizzle row types leak into UI** via `Sale`, `Product` in `lib/types.ts`. Tolerable because the mappers (`rowToSale`) translate strings → numbers and snake → camel. But the moment a UI consumer reads `r.attributesSnapshot` directly (which it does in dashboard cards), the abstraction has failed.
- **`branchId` is everywhere.** Branch context should be a request-scoped value resolved once in the middleware/handler, not a parameter threaded through 30 function signatures. Currently it's both.

**Architecture Health Score: 70/100**

---

## 6. Performance

### Frontend

- **91% of components are client components** (204/223). With Next 16 RSC + Cache Components, this is leaving most of the platform's performance budget on the floor. The dashboard (`app/page.tsx`) is `"use client"` despite having no interactivity at the page level — all state lives in the children.
- **Zero `loading.tsx` files** and only **5 `<Suspense>` usages**. Streaming + PPR is not happening anywhere.
- **Data waterfalls in client pages**: `/account/security` has 10 `fetch()` calls, `/customers/[phone]` has 6, `/settings` 5, `/purchases` 5. Each is a sequential network hop after hydration.
- **Components fetching their own data** — 38 client components contain `fetch(`. `<CategoriesEditor>` (7 fetches), `<TeamEditor>` (6 fetches), `<AttendanceRoster>` (6 fetches), `<AttendanceSettingsEditor>` (6 fetches). Same fetches re-fire on every navigation that re-mounts them.
- **Bundle**: `recharts`, `pdf-lib`, `@pdf-lib/fontkit`, `qrcode`, `@dnd-kit/*` and the icon set are all imported into the main app shell rather than route-segmented. No bundle analysis in CI.

### Backend

- **`recordCartSale` is an N+1.** Loop over `lines`, per-line `SELECT … FROM products … LIMIT 1` and per-line `loadAttributeSnapshot`. With 10-line invoices, that's 21 round trips inside one transaction. Should be one `SELECT … WHERE id IN (…)` + one attributes lookup.
- **`recordSale` (single-line)** has the same shape, fine for one product.
- **`materializeDueRecurringExpenses` cron** is in the same file (operations.ts:1295), also worth inspecting for the same pattern.
- **Connection pool size = 10** for the runtime client. With a per-request transaction model and 169 routes, this caps you at 10 concurrent in-flight writes. **Fine at 10 tenants, painful at 1,000.** Compose multiple repo calls inside one `withTenant` instead of nesting transactions.
- **User context cache (`USER_CONTEXT_TTL_SEC = 60`)** is excellent — it short-circuits the per-request 4-table JOIN.
- **`logActivity` runs synchronously** inline in handlers. At scale, route it through a queue.

### Database

- **205 declared indexes (87 in schema + 118 in raw SQL)** across 53 tables — generally healthy.
- **No query plans audited in CI.** No `pg_stat_statements` dashboard wired.
- **Heavy hitters not verified by EXPLAIN:** `/api/insights/overview`, `/api/admin/sales/overview` (627-line admin sales repo), `/api/cron/digest-tick`. These are the queries that will OOM first.
- **`activity_logs` is the inevitable hot-spot table.** Already has a cleanup cron (`cron/activity-log-cleanup`) — confirms the author saw it coming.
- **Pagination**: most listing routes (sales, customers, products) use offset pagination (`LIMIT/OFFSET`). Cursor pagination needed before 10K tenants × millions of rows.

### Top performance bottlenecks (ranked)

1. **N+1 in `recordCartSale`** — every POS sale.
2. **91% client components + no Suspense/streaming** — every navigation.
3. **38 components self-fetching after hydration** — every page load.
4. **DB pool = 10** — first concurrency wall.
5. **Synchronous `logActivity`** — turns into write amplification on every mutation.
6. **Offset pagination** — silent O(n) reads as tables grow.

**Performance Score: 55/100** — The DB layer is honest; the frontend is leaving Next 16's headline features unused.

---

## 7. Scalability

| Stage | Symptom | Bottleneck |
|---|---|---|
| **10 → 1,000 tenants** | Slow `/insights`, slow `/admin/sales/overview`, occasional pool exhaustion on POS spikes. | DB pool size + missing query-plan review + N+1 in POS. |
| **1,000 → 10,000 tenants** | activity_logs growth, RLS overhead measurable, Redis cache miss-storm on deploys, single-writer cron jobs serialise. | Single shared Redis (no cluster), single Postgres (no read replicas), cron jobs that iterate every tenant. |
| **10,000 → 100,000 tenants** | Single Postgres unsustainable. WhatsApp webhook fan-in becomes a hot path. PDF generation in-process under request load. | No tenant sharding strategy. No queue offload. No CDN strategy for receipts/uploads. |

- **DB** — `postgres-js`, single pool of 10. Healthy schema. No partitioning, no read replicas, no sharding plan. **First bottleneck.**
- **Cache** — Redis is opportunistic. Cache invalidation is precise (`bustUserContextCache`). At 10K tenants, single Redis becomes the hotspot.
- **Queue** — `bullmq` is installed but barely used. Notifications/digest/WhatsApp fan-out should be jobs by 1K tenants.
- **File storage** — `uploads/` is a host bind mount. Will not survive multi-node deploy. **Second bottleneck.** Move to S3-compatible storage before any horizontal scaling.
- **WebSocket / SSE** — `app/api/notifications/stream/route.ts` is SSE. Pinned to the Node process; won't fan out across instances without a Redis pub/sub bridge.
- **API rate limits** — `lib/ratelimit.ts` exists and is used on login. Per-tenant API limits should be standard before 1K tenants.

**Scalability Score: 50/100** — Built honestly for one shop, knowingly. The path to 1K tenants is clear; the path to 100K is not started.

---

## 8. React 19 Best Practices

- **Pages that should be Server Components are Client.** `app/page.tsx` (dashboard), `app/customers/page.tsx`, `app/customers/[phone]/page.tsx`. None of them are interactive at the page level — they delegate to children that are.
- **Hydration discipline is exemplary** in the sidebar (the recent flicker fix uses a stable DOM tree + `suppressHydrationWarning` correctly + `next/script beforeInteractive`). This is the strongest React 19 fluency in the codebase.
- **No stale closures observed** in spot checks.
- **135 `useEffect`s** — most are data fetches that would be better as server-side calls on a Server Component. Pattern: hook fetches on mount → renders skeleton → reflows. Move to `async function Page()` and stream.
- **5 `<Suspense>`**, **0 `loading.tsx`** — streaming is not in use.
- **Excellent**: the React 19 rules that bite (structural mismatch, inline `<script>`, removeChild) are documented in code comments where they were learned.

**React Quality Score: 55/100** — Local hygiene is great; architectural use of React 19 features is missing.

---

## 9. Next.js 16 Best Practices

- **`output: "standalone"`** — correct for the production Docker image.
- **Middleware is fat but coherent** (367 lines) — locale + auth + CSP + admin gate in one audit surface. Fine.
- **Server Actions: 1.** The only one is `app/[lang]/(auth)/actions.ts` (logout-side clears). Form submissions in the tenant app all go via `fetch` → route handler → JSON. Acceptable, but Server Actions would eliminate ~30 boilerplate route handlers.
- **Cache Components / PPR**: not used. The advisory in CLAUDE.md and AGENTS.md flags Next 16's breaking changes — the codebase has not yet adopted `use cache`, `cacheLife`, `cacheTag`. Insights, sales overview, customer listing are textbook candidates.
- **No `loading.tsx`**, no `error.tsx` outside root. Both are free wins.
- **`serverExternalPackages: ["postgres"]`** — correct.
- **`allowedDevOrigins`** is hardcoded to one developer's LAN — fine for dev, but should be gated by env.

**Next.js Quality Score: 55/100** — Sound foundation; Next 16's headline features are unadopted.

---

## 10. TypeScript

- **Strict mode on** (`"strict": true`).
- **`any` is rare** — 13 total annotations, 4 `as any`, 1 `@ts-expect-error`. Very disciplined.
- **`as unknown` (42)** is the more interesting number. Some are necessary (Sentry event types), some are smell (Drizzle row → DTO mappers could be typed at the boundary).
- **No widespread type duplication** — `lib/types.ts` is the single canonical export for `Sale`, `Product`, `Return`, etc. Drizzle's `$inferSelect` is used at the repo boundary to mint row types.
- **Generics used sparingly and correctly** — `cacheRemember<T>`, `withTenant<T>`. No generic gymnastics.
- **Path alias** `@/*` consistently used.
- **`eslint-disable` (32)** is mostly `react-hooks/exhaustive-deps` waivers in hooks — a smell but not a danger. Audit one-by-one.
- **One thing missing:** zod schemas don't share types with the Drizzle layer. There are two parallel descriptions of `recordSchema` (in `/api/sales/route.ts`) and `recordSale` (in `lib/repo/operations.ts`). When fields drift, the route handler accepts inputs the repo refuses.

**Type Safety Score: 80/100** — One of the strongest dimensions.

---

## 11. Maintainability

### What helps onboarding

- **README + AGENTS.md + CLAUDE.md** describe the model accurately.
- **Comments** carry root-cause + decision history. A new engineer can read why the sidebar uses a cookie companion in 2 lines.
- **Predictable file layout** — find any feature in 60 seconds.
- **`tests/isolation.test.ts`** doubles as a tenant-isolation spec.
- **The `PROJECT.md` reference** (this audit's sibling) is now the canonical entry point.

### What hurts onboarding

- **God files**. A new engineer cannot safely touch `operations.ts`, `SaleForm.tsx`, or `app/settings/page.tsx` without a half-day of reading.
- **2,091-line schema.ts**. Newcomer sees the whole data model at once. Defensible. Less defensible: relations, RLS migration notes, and table definitions interleave.
- **0 `loading.tsx`**, **1 `error.tsx`**, **1 Server Action**: a developer trying to follow Next 16 idioms can't learn them by reading this code.
- **47% route handlers have zod validation, 53% don't.** Inconsistent.
- **1,404 lines of tests against 83,922 lines of code = 1.7%.** The tenant-isolation suite is gold, but coverage is otherwise sparse. A new engineer can't safely refactor a repo function without writing the test first — and there's no nearby example for most domains.

**Maintainability Score: 65/100**

---

## 12. Refactoring Roadmap

### Priority 1 — Critical (do in next 4 weeks)

1. **Convert 7 direct-DB routes to use `withTenant` via repo functions.**
   - Effort: ½ day
   - Impact: Closes an RLS-bypass class.
   - Risk: Low.
   - Routes: `insights/staff-performance`, `customers/by-phone/[phone]/payments`, `settings/cash-drawer`, `auth/2fa-needed`, `account/email/check`, `account/store-handle/check`, `whatsapp/webhook/events/[id]/replay`.

2. **Fix N+1 in `recordCartSale` and `materializeDueRecurringExpenses`.**
   - Effort: 1 day (incl. tests).
   - Impact: 5–10× faster POS at large carts; biggest perf win available.
   - Risk: Medium (POS hot path — needs a sale-flow integration test).

3. **Replace Arabic exception messages with error codes.**
   - Effort: ½ day.
   - Impact: Errors stop becoming 500s. Lifts UI error surfacing across POS, settle, returns.
   - Risk: Low.

4. **Wire `pg_stat_statements` + basic query plans for the top-10 routes.**
   - Effort: 1 day.
   - Impact: Stops perf regressions from landing silently.
   - Risk: Zero.

### Priority 2 — High value (next quarter)

5. **Split `lib/repo/operations.ts`** → `sales.ts` / `returns.ts` / `expenses.ts`.
   - Effort: 1 day.
   - Impact: Unblocks parallel work; makes the cron flows discoverable.
   - Risk: Mechanical; covered by isolation suite + repo unit tests.

6. **Split `components/sales/SaleForm.tsx`** → `useCart()` + `<CartLineEditor>` + `<DiscountControls>` + `<ReceiptDispatcher>`.
   - Effort: 2–3 days.
   - Impact: Every future POS change benefits.
   - Risk: Medium — needs Playwright coverage on the POS flow first.

7. **Adopt Server Components on the dashboard, customers list, sales list, insights.**
   - Effort: 3 days.
   - Impact: Removes data waterfalls; eliminates 4–5 of the 32 client pages; first taste of streaming.
   - Risk: Medium — branch context + session need to flow through `headers()` rather than hooks.

8. **Add `loading.tsx` per route segment.**
   - Effort: ½ day.
   - Impact: Streaming UX with no other refactors.
   - Risk: None.

9. **Eliminate the 32 `eslint-disable react-hooks/exhaustive-deps` waivers** in hooks.
   - Effort: 1–2 days.
   - Impact: Removes a class of stale-closure bugs.
   - Risk: Low per-file, but spread across 32 files — schedule a sprint.

10. **Adopt Cache Components (`use cache`, `cacheLife`, `cacheTag`) for read-mostly views**: dashboard widgets, insights overview, customer detail.
    - Effort: 2 days.
    - Impact: Real reduction in DB load; foundation for 1K-tenant scale.
    - Risk: Low if scoped to read endpoints.

### Priority 3 — Nice to have

11. **Extract a `lib/services/` layer** for cross-domain flows (sale + cash + wallet + notifications + activity + digest).
12. **Move logActivity to BullMQ** behind a fire-and-forget interface.
13. **Move file uploads off the host bind mount** to S3/R2.
14. **Convert form submissions to Server Actions** where the route only mutates and redirects.
15. **Introduce a payments strategy** abstraction (`PaymentMethodHandler`) ready for Paymob.
16. **Bundle analyser in CI** with a budget guardrail.
17. **Replace offset pagination with cursor pagination** on sales, products, customers, activity_logs.
18. **Move admin to its own Next.js project** in `apps/` (the `apps/` dir already exists for this).
19. **Consolidate `lib/whatsapp.ts` and `lib/whatsapp/`** under the folder.
20. **Postgres ENUMs** for `paymentMethod`, `discountType`, `tenantMember.role` instead of `text + CHECK`.

---

## 13. Engineering Report Card

| Dimension | Score (0–100) | One-line verdict |
|---|---|---|
| **Security** | 80 | RLS + companion-cookie discipline + scrub-before-send + admin guard. Held back by 7 routes bypassing the repo and a permissive `style-src 'unsafe-inline'`. |
| **Architecture** | 70 | Right layers, right boundaries, three god modules forming. |
| **SOLID** | 60 | One god module (operations.ts), one god component (SaleForm), DIP slips in 7 places. |
| **Clean Code** | 68 | High-signal comments; oversized files drag the average down. |
| **Performance** | 55 | DB sound. Frontend leaves Next 16 features on the floor. |
| **Scalability** | 50 | Honest single-instance design. Path to 1K is clear; path to 100K isn't. |
| **Reliability** | 65 | Sentry + structured errors + retry-friendly idempotency. But 0 `error.tsx` segments, inline cron logic, no queue for side effects. |
| **Maintainability** | 65 | Predictability is high. Three god files are the single biggest barrier to a new engineer. |
| **Type Safety** | 80 | Strict mode, minimal `any`, sane DTOs. One drift risk: zod schemas not co-derived with Drizzle. |
| **Testing** | 35 | The isolation suite is excellent; everything else is uncovered. 1.7% test:src ratio. |
| **Production Readiness** | 60 | Standalone build, Sentry, healthz/readyz, backups, RLS. But no deploy pipeline, no per-tenant rate limits, file uploads on bind mount, SSE pinned to instance. |

### Overall: **62 / 100**

---

## 14. Engineering Level

| Bar | Pattern |
|---|---|
| **Mid-level engineer** | Ships features. Comments are scarce. Schemas drift. Tests are missing. RLS would not exist. Frontend would be 100% client. |
| **Senior engineer** | Has the right layers. Comments the gotchas. Tests the riskiest invariant (tenant isolation). Picks the right tools (RLS, Drizzle, Auth.js, Redis as opportunistic cache). Tolerates god files until the next refactor sprint. |
| **Staff engineer** | Would not have a 1,394-line client component. Would not have 7 direct-DB routes. Would have wired a service layer + queue + cache-components by now. Would have ≥30% test coverage and a perf budget. |
| **Principal engineer** | Would have multi-region story drafted, sharding decision documented, pg_stat_statements on a Grafana board, a cost model per tenant. |

**This codebase sits firmly at the upper end of Senior.** It is meaningfully better than typical senior work in three specific ways:

1. The "why" comments. They are not vanity — they capture incident-level knowledge that would otherwise live in chat scrollback.
2. The RLS-as-safety-net + role-separation discipline. Most senior-led codebases never get this right.
3. The hydration debugging fluency in the sidebar/splash story. That is staff-level taste applied to a senior-level surface.

It falls short of Staff in three specific ways:

1. **Three god files** (`operations.ts`, `SaleForm.tsx`, `settings/page.tsx`) that a staff engineer would have split before they grew this large.
2. **Testing investment is below the bar.** 1.7% test:src is not sustainable on a payment-handling system.
3. **Next 16's headline features are unused.** A staff engineer building on Next 16 in 2026 would be using Server Components, streaming, and Cache Components as the default — not the exception.

### If you do nothing else

- Land **Priority 1 #1 + #2** this week. They close a security class and the worst performance hot path.
- Land **Priority 2 #5 + #6 + #8** before adding more features to sales/settings.
- Stop letting client pages grow past 400 lines. Use it as a tripwire in code review.
