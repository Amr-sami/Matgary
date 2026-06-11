# Dashboard Scaling (Track 2)

Per-widget measurement of the Phase 4A dashboard, applied to the three tenant scales generated for Phase 6. Identifies which widgets cache, which stream, which precompute.

**Source data**: `tests/perf/scale-results.json` (p100 / p1k / p10k tenants) + Phase 4A architecture review.

---

## 1. Per-widget inventory (from `app/page.tsx`)

The Phase 4A dashboard renders **three async Server Component widgets**, each opening its own data path:

| Widget | Data path | Cached today? | TTL |
|---|---|---|---|
| **`<StatsGridServer>`** | `loadDashboardStats(tenantId, branchId)` → 4 SQL aggregates wrapped in `cacheRemember` | **YES** (Phase 4B) | 60 s |
| **`<LowStockAlertServer>`** | `listProducts(tenantId, branchId)` → returns **every product** for the tenant, then filters by `quantity <= lowStockThreshold` client-side (in the SC) | NO | — |
| **`<RecentSalesListServer>`** | `listSalesPage(tenantId, { branchId, limit: 10 })` → cursor-paginated, returns 10 rows | NO | — |

Plus a fixed cost shared by every render:
- `auth()` → JWT verification + user-context cache hit (~0.5 ms)
- `resolveActiveBranch(ctx)` → cookie read + branch resolution (per-request `BEGIN` + `set_config` + branch lookup)
- `getDictionary(locale)` → JSON import (cached by Node module cache after first hit, ~0 ms)

---

## 2. How each widget scales (measured)

Dashboard render p50 latency from `tests/perf/scale-results.json`:

| Scale | Dashboard p50 | Dashboard p95 | Dashboard body |
|---|---|---|---|
| 100 products / 500 sales | 24.4 ms | 76.6 ms | 188.4 KB |
| 1,000 products / 5,000 sales | 44.5 ms | 154.1 ms | 188.4 KB |
| 10,000 products / 50,000 sales | 63.7 ms | 249.8 ms | 188.4 KB |

Per-endpoint scaling that feeds the widgets:

| Endpoint | p100 p50 | p1k p50 | p10k p50 | Δ p100→p10k |
|---|---|---|---|---|
| `GET /api/products` (proxy for `listProducts`) | 11.7 ms | 19.0 ms | **83.8 ms** | **+617%** |
| `GET /api/products` body | 32.6 KB | 326.7 KB | **3,276.3 KB** | **×100** |
| `GET /api/sales?paginated=1&limit=50` | 10.6 ms | 10.0 ms | 9.5 ms | flat |
| `GET /api/insights/overview` (cache hit path) | 9.5 ms | 8.1 ms | 8.0 ms | flat |

### What this tells us

- **Dashboard body is flat at 188 KB** across all scales because the rendered HTML caps the visible rows (top-10 low-stock + top-10 recent sales). Good — the *delivered* payload doesn't grow.
- **Dashboard p50 grows ~2.6× from p100 → p10k**, all of it explained by `listProducts` scaling from 11.7ms to 83.8ms. The widget *reads* every product to filter for low-stock, even though only 10 render.
- `RecentSalesList` doesn't scale with sale count thanks to Phase 2.4's cursor pagination — `listSalesPage(limit=10)` is flat at ~10 ms.
- `StatsGridServer` is flat at ~5 ms because of Phase 4B's cache.

---

## 3. Widget-by-widget recommendation

### `<StatsGridServer>` — DO NOTHING

Already cached at 60 s TTL via `loadDashboardStats`. Bust hooks land on every sale/return/expense via `bustInsightsCache`. p99 from Phase 4 was 10 ms.

This is the reference for what Phase 6 caching should look like.

### `<LowStockAlertServer>` — **MUST CACHE**

This is the dashboard's worst offender. At 10K products:
- `listProducts` ships **3.3 MB of JSON across the SC boundary** every render — to display 10 alert rows.
- Filtering happens in JS after the SC reads the rows.
- Zero caching today.

**Two changes** (both measurable, low risk):

1. **Push the filter to SQL.** Replace `listProducts(…)` + JS filter with a new repo function `listLowStockProducts(tenantId, branchId)` that returns only products with `quantity <= low_stock_threshold` (and ORDER BY quantity ASC). For a tenant with 10K products and ~50 low-stock items, that's a 200× row reduction on the SC payload.
2. **Cache the result with the existing `bustInsightsCache` seam.** 30 s TTL. Already busted on every sale/return/expense/product-write.

Predicted impact (extrapolating from Phase 4B's StatsGrid cache):
- p10k dashboard p50: **63.7 ms → ~15 ms** (eliminates the 83.8 ms `listProducts` read, replaces with ~1 ms cache hit)
- p10k dashboard p95: 249.8 ms → ~60 ms
- DB read traffic from dashboard: −95% (cache hit rate ~99% per Phase 4B precedent)

### `<RecentSalesListServer>` — STREAM, DO NOT CACHE

Reasons NOT to cache:
- Already flat at ~10 ms (cursor pagination from Phase 2.4 caps the work).
- High write rate on `sales` → cache invalidation fires on every POS sale → cache lifetime would be <1 second for a busy tenant.
- The widget shows the **10 newest** sales — staleness here is user-visible.

Better treatment:
- Keep as-is (uncached).
- Move the read INSIDE a `<Suspense>` boundary (already done in Phase 4A).
- At very high scale, swap to a streamed read (Phase 5C OTEL trace will tell us when this matters; it doesn't today).

### Shared per-render cost (`resolveActiveBranch`) — PRECOMPUTE

Every dashboard render (and every authenticated route) re-resolves the active branch:
- Cookie read
- `getAccessibleBranches(ctx)` → checks the `branch-allow` global cache (cached per user, 60 s)
- For owners, falls back to `listBranches` (which IS cached as of Phase 4C, 5 min)
- Then a final per-request `SELECT id, name, is_primary FROM branches WHERE tenant_id = $1 AND id IN (…)` — **NOT cached** (the `id IN` lookup varies by user/cookie)

This last query is the 442-calls-per-load-test query identified in Phase 5B as Bottleneck #3.

**Precompute opportunity**: cache the resolved `BranchContext` per (userId, cookieValue) for 30 s. Today only the *allow-list* is cached; we should cache the full resolved branch row too.

Predicted impact: removes 1 DB query per authenticated request — ~5 ms savings per page render, dashboard and otherwise.

---

## 4. Combined plan + measurable acceptance test

| Change | What | Where | Acceptance |
|---|---|---|---|
| 1 | `listLowStockProducts(tenantId, branchId)` repo function | new function in `lib/repo/catalog.ts` | Returns only rows with `quantity <= low_stock_threshold ORDER BY quantity ASC` |
| 2 | `loadDashboardLowStock(tenantId, branchId)` cached wrapper | new function in `lib/repo/insights.ts` | 30 s TTL; busted by existing `bustInsightsCache` |
| 3 | `LowStockAlertServer` uses #2 | `components/dashboard/LowStockAlertServer.tsx` | Same rendered HTML; no behaviour change |
| 4 | Cache resolved `BranchContext` per (userId, cookieValue) | `lib/api/branch-context.ts` | 30 s TTL; bust on `bustBranchAllowListCache` (already wired on branch write) |

**Acceptance test (re-run `tests/perf/measure-scale.ts`):**

| Metric | Today | Target |
|---|---|---|
| `dashboard-render` p50 at p10k | 63.7 ms | **< 25 ms** |
| `dashboard-render` p95 at p10k | 249.8 ms | **< 80 ms** |
| `products-list` p50 at p10k | 83.8 ms | unchanged (separate optimization — see §5) |

If those numbers aren't hit, the widget split didn't materialise the win — escalate to a fully separate `/api/dashboard/low-stock` endpoint with its own cache.

---

## 5. Not in scope (out of Phase 6 brief)

These are real findings from the scale test but they belong elsewhere:

- **`/api/products` at 10K products ships 3.3 MB JSON.** It's the single biggest scaling problem we measured. Needs **server-side pagination on the products endpoint**. Phase 4-style cursor variant. Not a Track 2 dashboard issue per se — it's a general read-pagination gap. Flagged for Phase 7.
- **`/api/insights/overview`** has a window-parameterized cache key (Phase 4B) that handles per-tenant scaling well. Confirmed flat at 8 ms across all scales.
- **`/api/branches` and `/api/categories`** confirmed flat (cached in Phase 4C and earlier).

---

## 6. Implementation budget

| Step | Effort |
|---|---|
| `listLowStockProducts` repo function | 0.5 day |
| `loadDashboardLowStock` cache wrapper + wire | 0.5 day |
| `LowStockAlertServer` swap | 0.5 day |
| Branch context cache | 0.5 day |
| Re-measure + update `tests/perf/scale-results.json` | 0.5 day |
| Total | **~2.5 days** |
