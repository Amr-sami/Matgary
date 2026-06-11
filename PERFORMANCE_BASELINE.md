# Performance Baseline

**Captured**: 2026-06-11 against `next build` + `next start -p 3100` (production mode), single owner tenant, ~12 categories + sample products + a couple of cash shifts, in `localhost` against docker Postgres + Redis. All measurements are local; absolute values won't match a production-scale tenant, but the **relative cost of each path is stable** and that's what future optimization work measures against.

This document is the contract: any Phase 4+ refactor MUST show a numeric improvement against the row(s) it claims to touch, or the work is reverted.

---

## 1. How to reproduce

```bash
# infra
docker compose up -d postgres redis
npm run db:migrate

# build + serve
npm run build
NODE_ENV=production npx next start -p 3100 &

# one-time enable pg_stat_statements (already applied via migration 0039,
# but Postgres requires shared_preload_libraries + restart to collect)
docker exec matgary-postgres psql -U matgary -d matgary \
  -c "ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';"
docker restart matgary-postgres

# provision the shared owner + login cookies (Playwright)
PLAYWRIGHT_NO_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3100 \
  npx playwright test pos-sale.spec.ts --reporter=list

# reset Postgres stats so the baseline is clean
docker exec matgary-postgres psql -U matgary -d matgary \
  -c "SELECT pg_stat_statements_reset();"

# probes
BASE=http://localhost:3100 ITER=30 npx tsx tests/perf/measure-baseline.ts
BASE=http://localhost:3100 ITER=8  npx tsx tests/perf/measure-pages.ts
```

The two probe scripts dump JSON to `tests/perf/baseline.json` and `tests/perf/pages-baseline.json` so a future run can diff against them.

---

## 2. Current baseline

### 2.1 Frontend — bundle composition

| Artifact bucket | Size |
|---|---|
| `.next/static/` total | **4.2 MB** |
| Root main bundle (shared by every route, gzipped on the wire — raw bytes here) | **445 KB across 6 chunks** |
| Largest single client chunk | **405 KB** (`0bcg9e_h2ca~n.js`) |
| Top 3 client chunks combined | **812 KB raw** (recharts + pdf-lib + @dnd-kit suspects) |
| Top 8 client chunks combined | **1.36 MB raw** |
| Per-route client-reference-manifest size | 13–22 KB (within ±10% across tenant pages) |

### 2.2 Frontend — hydration cost (counts that drive client work)

| Metric | Value |
|---|---|
| Total `.tsx` files | **234** |
| Files with `"use client"` | **185 (79.0%)** |
| Pages — Server Components | 22 |
| Pages — Client Components | **32** |
| `useState` call sites | **341** |
| `useEffect` call sites | **138** |
| `useMemo` call sites | 76 |
| `useCallback` call sites | 62 |
| Inline `fetch()` calls in client components | **38 files** |
| `<Suspense>` usages | 8 |
| `loading.tsx` files | 8 |
| `error.tsx` files | 4 |
| Server Actions | **1** |

### 2.3 Frontend — heaviest files (god-component watch)

| File | LOC | Hook calls |
|---|---|---|
| `app/settings/page.tsx` | **1,584** | 14 |
| `components/sales/SaleForm.tsx` | **1,394** | 21 |
| `components/settings/TeamEditor.tsx` | 903 | 10 |
| `app/customers/[phone]/page.tsx` | 901 | 11 |
| `app/admin/broadcasts/BroadcastsClient.tsx` | 826 | — |
| `components/settings/ReceiptDesigner.tsx` | 711 | — |
| `app/inventory/page.tsx` | **695** | **22** (highest in repo) |
| `app/sales/page.tsx` | 604 | 20 |
| `app/purchases/page.tsx` | 596 | — |

### 2.4 Frontend — heaviest self-fetching client components (data waterfall risk)

| Component | `fetch()` calls inline |
|---|---|
| `components/settings/CategoriesEditor.tsx` | 7 |
| `components/team/AttendanceSettingsEditor.tsx` | 6 |
| `components/team/AttendanceRoster.tsx` | 6 |
| `components/settings/TeamEditor.tsx` | 6 |
| `components/whatsapp/ThreadView.tsx` | 5 |
| `components/team/CompensationEditor.tsx` | 5 |
| `components/tasks/TasksTab.tsx` | 4 |
| `components/sales/SaleForm.tsx` | 4 |
| `components/leave/LeaveTab.tsx` | 4 |

### 2.5 Frontend — page TTFB + payload (production `next start`, authenticated, warm)

10 iterations per page, p50/p95 reported. HTML payload size is uncompressed bytes of the SSR response.

| Route | TTFB p50 | TTFB p95 | Total p50 | Total p95 | HTML body |
|---|---|---|---|---|---|
| `/` | 54 ms | **94 ms** | 67 ms | 107 ms | 205.8 KB |
| `/sales` | 53 ms | 56 ms | 62 ms | 69 ms | **235.0 KB** |
| `/inventory` | 49 ms | 60 ms | 61 ms | 74 ms | 227.8 KB |
| `/customers` | 47 ms | 53 ms | 60 ms | 65 ms | 219.8 KB |
| `/insights` | 50 ms | 54 ms | 63 ms | 67 ms | 215.7 KB |
| `/settings` | 45 ms | 52 ms | 59 ms | 63 ms | 206.0 KB |
| `/purchases` | 51 ms | 59 ms | 63 ms | 72 ms | 221.4 KB |
| `/team` | 46 ms | 53 ms | 59 ms | 65 ms | 207.8 KB |
| `/tasks` | 45 ms | 52 ms | 57 ms | 64 ms | 199.9 KB |
| `/expenses` | 47 ms | 74 ms | 59 ms | 83 ms | 208.1 KB |
| `/cash-shifts` | 46 ms | 48 ms | 58 ms | 64 ms | 206.0 KB |

> The TTFBs are uniformly ~45–55 ms on localhost because most pages are client-rendered shells: the server returns the same skeleton HTML for everyone, then the browser fetches data after hydration. **HTML payload variance reflects the page tree shape, not data weight.** Real page perceived-latency is dominated by post-hydration `fetch()` waterfalls (§2.4) which `curl`/Playwright `goto` doesn't see.

### 2.6 Backend — API latency p50/p95/p99 (production server, warm, 30 iter)

| Endpoint | p50 | p95 | p99 | mean |
|---|---|---|---|---|
| `GET /healthz` | 2.9 ms | 11.2 ms | 11.3 ms | 3.9 ms |
| `GET /readyz` | 4.4 ms | 5.5 ms | 10.1 ms | 4.5 ms |
| `GET /api/plans` | 4.4 ms | 6.8 ms | 8.0 ms | 4.7 ms |
| `GET /api/branches` | 7.1 ms | 8.3 ms | 8.7 ms | 7.1 ms |
| `GET /api/notifications` | 6.2 ms | 8.2 ms | 11.4 ms | 6.5 ms |
| `GET /api/activity` | 6.3 ms | 8.0 ms | 8.8 ms | 6.5 ms |
| `GET /api/settings` | 6.8 ms | 7.9 ms | 8.3 ms | 6.8 ms |
| `GET /api/insights/overview` | 7.2 ms | 13.7 ms | **42.6 ms** | 8.5 ms |
| `GET /api/team` | 7.4 ms | 8.0 ms | 10.2 ms | 7.4 ms |
| `GET /api/categories` | 7.5 ms | 9.1 ms | 14.7 ms | 7.7 ms |
| `GET /api/customers/by-phone` | 8.9 ms | 10.0 ms | 11.2 ms | 9.0 ms |
| `GET /api/returns` | 8.9 ms | 10.3 ms | 11.4 ms | 9.0 ms |
| `GET /api/sales?paginated=1` | 9.7 ms | 11.8 ms | 12.6 ms | 9.9 ms |
| `GET /api/sales` (legacy unpaginated) | 9.9 ms | 11.1 ms | 12.0 ms | 10.0 ms |
| `GET /api/cash-shifts/current` | 10.0 ms | 11.6 ms | 12.4 ms | 10.2 ms |
| `GET /api/cash-shifts` | 10.2 ms | 15.5 ms | **34.9 ms** | 11.3 ms |
| `GET /api/products` | 10.1 ms | 11.9 ms | 12.3 ms | 10.2 ms |
| `GET /api/expenses` | 10.4 ms | 12.5 ms | 13.3 ms | 10.5 ms |

**Slowest endpoints by p99**: `/api/insights/overview` (42.6 ms), `/api/cash-shifts` (34.9 ms). Both involve aggregation queries that materially benefit from caching at scale.

### 2.7 Database — pg_stat_statements (after the 33-iter probe sweep)

#### Top queries by total exec time

| Calls | Total ms | Mean ms | Rows | Query |
|---|---|---|---|---|
| **429** | 10.0 | 0.02 | 429 | `SELECT id, name, is_primary FROM branches WHERE tenant_id=$1 AND id IN ($...)` |
| 33 | 9.0 | 0.27 | 2,079 | `SELECT … FROM sales WHERE …` (full read for /api/sales) |
| 33 | 6.9 | 0.21 | 1,683 | `SELECT … FROM sales WHERE …` (cursor variant) |
| 33 | 5.0 | 0.15 | 2,541 | `SELECT … FROM products WHERE tenant_id=$1` |
| 33 | 4.7 | 0.14 | 1,650 | `SELECT … FROM activity_logs WHERE tenant_id=$1` |
| **895** | 4.6 | 0.01 | 895 | `SELECT set_config($2, $1, $3)` (`withTenant` setting `app.tenant_id`) |
| 33 | 1.9 | 0.06 | 33 | `SELECT DISTINCT ON … actor_user_id` (actor backfill for activity) |
| 33 | 1.9 | 0.06 | 462 | `SELECT … FROM returns WHERE tenant_id=$1` |
| 33 | 1.6 | 0.05 | 231 | `SELECT … FROM sales WHERE invoice_id=$1` |
| 33 | 1.6 | 0.05 | 165 | `SELECT … FROM cash_shifts WHERE tenant_id=$1` |

#### Highest call frequency

| Calls | Mean ms | Total ms | Query |
|---|---|---|---|
| 895 | 0.00 | 0.5 | `BEGIN` |
| 895 | 0.01 | 4.6 | `SELECT set_config('app.tenant_id', $1, true)` |
| **429** | **0.02** | **10.0** | `SELECT id, name, is_primary FROM branches WHERE tenant_id=$1 AND id IN (…)` |
| 66 | 0.02 | 1.1 | actor-name resolve (`users LEFT JOIN tenant_members`) |
| 66 | 0.01 | 0.7 | `SELECT id, name FROM branches WHERE tenant_id=$1 AND id IN (…)` |

#### Slowest queries by mean

After excluding the bootstrap-only `pg_catalog.pg_type` introspection query (0.65 ms mean, called twice at boot), **NO query exceeds 1 ms mean** on this dataset. Aggregation paths (insights, cash-shifts) will land here first as tenant data grows.

> All queries run inside a `withTenant` transaction — `BEGIN` + `set_config('app.tenant_id', …)` is the cheapest fixed cost in the system (~0.02 ms combined) but is paid once per API call. **At 1,000 RPS that's 20 s of pure transaction-management CPU per second** — first thing to revisit when the pool is the bottleneck.

### 2.8 Pool utilisation

| Metric | Value |
|---|---|
| Configured pool size | **10** (`lib/db/index.ts` — `postgres({ max: 10 })`) |
| Connections during baseline | 1 active, 0 idle |
| Concurrent peak observed | 1 |

The pool is unstressed at this load. The probe is sequential (single tester) — concurrent load will be measured separately when the load-test rig is set up.

### 2.9 Cache — Redis

| Metric | Value |
|---|---|
| `keyspace_hits` (cumulative) | 4,586 |
| `keyspace_misses` (cumulative) | 1,378 |
| **Hit rate** | **76.9%** |
| `expired_keys` | 148 |
| `evicted_keys` | 0 |
| Total commands processed | 12,117 |
| Active keys at baseline end | 7 |

Active keys observed (all correctly tenant-scoped under the `matgary:production:v1:t:<tenantId>:…` convention):
- `userctx:<userId>` — JWT-callback tenant-context cache (60 s TTL)
- `branch-allow:<tenantId>:<userId>` — accessible branches per user
- `t:<tenantId>:catalog:categories:<branchId>` — catalog read
- `t:<tenantId>:settings:<branchId>` — shop settings (5 min TTL)
- `rl:signup.ip:::1` — rate-limit window key

The catalog + settings caches hit on every page after the first; the userctx cache hits on every authenticated request after the first 60 s. **76.9% is the floor for hit rate** — at this small dataset most reads aren't cached at all (sales/products/cash-shifts) so a miss is the right answer. As Cache Components land (see §3) this number should climb past 90%.

#### What's NOT cached today

- `/api/insights/overview` (slowest p99) — `task.md` admits this explicitly
- `/api/sales` (read-mostly hot path)
- `/api/products` (read-mostly hot path)
- `/api/customers/by-phone` (read-mostly, per-page)
- `/api/cash-shifts` (varies per minute, but server aggregation is the cost)
- `/api/notifications` (varies per second, intentional)
- `/api/activity` (varies per write, intentional)

---

## 3. Top 10 optimization opportunities (ranked by ROI per unit risk)

Each entry: **what** → **expected impact** → **risk** → **prerequisite**.

| # | Opportunity | Expected impact | Risk | Prereq |
|---|---|---|---|---|
| 1 | **Dashboard `/` → Server Component + Suspense streaming** | TTFB p95 94→<60 ms; eliminates 12 client widgets' mount-fetch waterfall | Low | None (Phase 1 streaming infra landed) |
| 2 | **Insights overview → `'use cache'` + `cacheTag("tenant:${id}:insights")`** | p99 42 ms → <10 ms on cache hit; matches the existing `bustInsightsCache` invalidation hook | Low | None |
| 3 | **Settings tab routing (`/settings/{shop,whatsapp,…}`)** | Per-tab bundle reduction: today's settings page weight is ~80% unused on first paint | Med | 3 settings smoke tests (PHASE3.md) |
| 4 | **Catalog reads behind `cacheTag("tenant:${id}:catalog")` (already cached in Redis at 5 min TTL — surface via the framework)** | Removes the per-page 7.5 ms branches+categories pair; `updateTag` on catalog writes already exists in spirit (`cacheBustPrefix`) | Low | None |
| 5 | **Sales list (`/sales`) — Server Component initial paint + cursor pagination wired to UI** | HTML payload 235→~70 KB; hydration `useEffect(20)`→1 | Med | SaleForm decomposition partially started |
| 6 | **`recordCartSale` already-shipped N+1 fix → measure POS p95** | Cart-of-10 latency: 21 round-trips → 4. Not yet measured under load. | Low | Load-test rig (item 10) |
| 7 | **Drop `withTenant` BEGIN/set_config overhead for read-only requests** | ~0.02 ms × every API call. At baseline ~9% of repo-layer cost. RLS still fires because the policy passes through. | High | Audit which routes never write |
| 8 | **`logActivity` → BullMQ queue (already feature-flagged behind `ACTIVITY_LOG_QUEUE=1`)** | Removes one DB write from every mutation hot path | Low | Phase 1.5 worker is shipped; just enable in env |
| 9 | **HTTP `Cache-Control` headers on read-only tenant-scoped endpoints (`/api/branches`, `/api/categories`, `/api/brands`)** | Tab-switch latency 7 ms → 0 ms (304/private-cache); zero server cost on revisit | Low | None |
| 10 | **Concurrent load-test rig (autocannon/k6 against the prod build) — to surface the real pool=10 ceiling** | Generates the data this baseline can't (concurrent p95). Required to validate items 1, 2, 6 under real load. | Low | None |

---

## 4. Expected gains from upcoming refactors

These are quantified PREDICTIONS against the baseline. Each refactor's PR must include a re-run of the probes and show the predicted Δ landed (or revise the prediction).

### 4.1 Settings refactor (per-tab routes + dynamic imports + 2 hooks)

| Metric | Today | After | Δ |
|---|---|---|---|
| `app/settings/page.tsx` LOC | 1,584 | ~120 orchestrator | **−1,460 LOC** in monolith |
| Hooks on first `/settings` paint | 14 | ~2 | **−12 hooks** |
| Settings HTML payload | 206 KB | ~80 KB (first tab only) | **−126 KB** |
| First-paint `fetch()` count | 5 | 1 | **−4 fetches** |
| `/settings` TTFB p95 | 52 ms | ~50 ms | ~0 (server is fast already; win is bundle + hydration) |
| Tab-switch perceived latency | full re-render | route swap | **single-digit ms** |

### 4.2 Dashboard RSC migration (`/` → Server Component)

| Metric | Today | After | Δ |
|---|---|---|---|
| `/` TTFB p95 | 94 ms | **~40 ms** | **−54 ms** (no shell-render-then-fetch) |
| `/` HTML payload | 205.8 KB | ~120 KB | **−85 KB** (most widgets emit server-rendered HTML, not client placeholders) |
| Client hooks on dashboard | 0 (page) + many in children | ~3 (interactive leaves only) | -high |
| Post-hydration network requests | 3 (stats + low-stock + recent-sales) | 0 on first paint | **−3 round trips** |
| Server compute per request | dominated by 3 sequential reads from children | 3 parallel awaits at the SC layer | small but measurable |

### 4.3 Cache Components (`'use cache'` + `cacheTag` on insights + catalog + sales-list)

| Metric | Today | After (cache hit) | Δ |
|---|---|---|---|
| `/api/insights/overview` p99 | 42.6 ms | **<10 ms** | **−32 ms** (~75%) |
| `/api/categories` p50 | 7.5 ms | <3 ms | −4.5 ms (~60%) |
| `/api/branches` p50 | 7.1 ms | <2 ms | −5 ms (~70%) |
| Redis hit rate | 76.9% | **~95%** | +18 pts |
| DB read pressure on hot reads | 1× per page-load | 1× per cache-life | matches the `cacheLife("seconds"|"minutes")` choice |

The `bustInsightsCache` function exists and is called by sale/return/expense writers — adapting it to call `updateTag` is one-import, one-function-call.

### 4.4 SaleForm decomposition (`useCart` + 7 components)

| Metric | Today | After | Δ |
|---|---|---|---|
| `components/sales/SaleForm.tsx` LOC | 1,394 | ~250 (orchestrator) | **−1,140 LOC** in monolith |
| Hooks in the orchestrator | 21 | ~5 | **−16 hooks** |
| Total LOC across new files | 0 | ~1,140 | net 0 |
| `useEffect` count app-wide | 138 | 138 (most move to hooks) | ~0 (count-level), but bundleable |
| Test surface available | 1 monolith | 4 hooks + 7 components | **major** — unit-testable in isolation |
| POS `/api/sales/cart` POST p95 (assumes form-side fixes don't change route) | (unaffected) | (unaffected) | this is a structural refactor; the perf wins came in Phase 1 N+1 fix |

The SaleForm decomposition's payoff is **maintainability and risk reduction**, not raw perf. The runtime perf wins for the POS already landed in Phase 1 (`recordCartSale` N+1 fix). What this refactor unblocks is **future** per-component optimization (e.g. memoising line discount calc, lazy-loading the receipt PDF code on submit only).

---

## 5. What this baseline does NOT cover (honest gaps)

These are intentionally documented so a future engineer doesn't assume they're measured:

- **Concurrent load** — single-threaded probe only. Pool=10 ceiling, queue contention, lock waits are invisible at this scale. Item 10 in §3 is the fix.
- **Real-world data** — single owner, ~12 categories, a handful of products, a couple of cash shifts. Tenants with 10K+ products will surface different hot queries; `/api/insights/overview` will be hit hardest first.
- **Cold start / JIT warmup** — first 3 hits per endpoint discarded as warmup; we measure steady-state, not the first user of the day.
- **Network** — localhost. Real client perf adds ~30–80 ms RTT + TLS handshake + HTTP/2 head-of-line for the first paint. The bundle work in §3 items 3+5 matter most here.
- **Mobile devices** — bundle weight is more punishing on slow phones than the baseline `chromium` headless on this Mac shows. The 405 KB largest single chunk will dominate cold-load TTI on a 3G connection.
- **Memory + CPU per process** — only latency is captured. Node heap growth under sustained load is unmeasured.
- **WhatsApp send / webhook ingest** — not in the probe set (requires Meta mock).
- **PDF generation cost** — `pdf-lib` is in the top-3 client chunks (~200 KB) but the cost of generating a receipt server-side under load is not measured.

---

## 6. Optimization gate (the contract)

A future refactor that claims a perf improvement MUST satisfy this gate before merging:

1. Re-run `tests/perf/measure-baseline.ts` and `tests/perf/measure-pages.ts` against the refactor branch.
2. Diff `tests/perf/baseline.json` against the refactor's run; check each touched row.
3. Include the diff in the PR description.
4. For Cache Components additions: include the new hit-rate from `redis-cli INFO stats`.
5. For Server Components migrations: include the page TTFB p95 row from the diff AND the HTML payload bytes Δ.

A refactor that doesn't measurably move at least one row in `baseline.json` or `pages-baseline.json` is **not a perf refactor** — it goes through Phase 4's normal correctness review instead.

---

## 7. Where the data lives

| File | Purpose |
|---|---|
| `tests/perf/measure-baseline.ts` | API latency probe |
| `tests/perf/measure-pages.ts` | Page TTFB + payload probe |
| `tests/perf/baseline.json` | Last API-latency baseline JSON |
| `tests/perf/pages-baseline.json` | Last page-TTFB baseline JSON |
| `lib/db/migrations/0039_pg_stat_statements.sql` | DB extension migration |
| **This file** | The numbers + the contract |

The two JSON outputs are checked into the repo as the baseline a future run diffs against. Refactor PRs update them.
