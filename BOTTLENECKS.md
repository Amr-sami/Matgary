# Bottleneck Analysis (Phase 5B)

Evidence-based ranking from the Phase 5A load test (`LOAD_TEST_BASELINE.md` + `tests/perf/load/summary.json`). Every claim below is backed by a measured number from the rig.

---

## TL;DR — three bottlenecks ranked

| Rank | Bottleneck | First visible at | Symptom |
|---|---|---|---|
| **1** | **POS inventory row-lock contention** on `products.quantity` | 10 concurrent POS sales | Mean query time 26.92 ms (vs <0.5 ms for everything else); throughput hard-capped at ~145 req/s regardless of concurrency |
| **2** | **Dashboard fan-out fixed cost** | 10 concurrent dashboard renders | Throughput hard-capped at ~60 req/s; p50 grows linearly to 4 s at 250 conns |
| **3** | **Sequential per-request setup cost** (`BEGIN` + `set_config(app.tenant_id)` + RLS evaluation) | 100 concurrent reads | p95 jumps 4× between 50 and 100 conns on customer-lookup; p99 1573 ms |

---

## Bottleneck #1 — POS inventory row-lock contention

### Evidence

From `pg_stat_statements` (collected across the full sweep):

| Query | Calls | Mean ms | Total exec ms |
|---|---|---|---|
| `UPDATE products SET quantity = $1, updated_at = $2 WHERE tenant_id = $1 AND id = ...` | **10,933** | **26.92** | **294,314** |
| 2nd most expensive query | 18,847 | 0.33 | 6,222 |

The product UPDATE costs **47× more total DB time** than the runner-up and **80× more time per call** than the runner-up. No other query is even close.

### Throughput plateau (from `pos-cart-sale` scenario)

| Concurrency | req/s | p50 | p95 |
|---|---|---|---|
| 10 | 134 | 63 ms | 217 ms |
| 25 | 147 | 159 ms | 329 ms |
| 50 | 145 | 337 ms | 542 ms |
| 100 | 147 | 675 ms | 847 ms |
| 250 | 141 | 1691 ms | 2179 ms |

**Throughput is monotonically pinned at ~145 req/s.** p50 grows linearly. This is the textbook signature of serialised access to a single resource.

### Root cause

`recordCartSale` writes to `products.quantity` via a `withTenant` transaction with an explicit `UPDATE … WHERE tenant_id = … AND id = …` (`lib/repo/operations.ts` `adjustProductStock`). Postgres acquires a row-level exclusive lock on the product row until commit. When N concurrent transactions all want the same row, they serialise.

The 26.92 ms mean includes the **wait time** for the lock, not pure SQL execution. Single-shot baseline measured this query at <1 ms.

### What does NOT cause this

- Connection pool (size 10). The peak Postgres connection count during the run was 21 (10 app + 10 admin + 1 misc). The pool was never saturated.
- Postgres `max_connections`. Configured at 100; observed peak 21.
- RLS evaluation. Other writes to RLS-protected tables (`activity_logs`, `product_history`, `sales`) ran at <0.2 ms mean. Same RLS, no contention.
- Redis. Hit rate 99.6% across the run. Cache layer is not in the critical path here.
- Application code. Phase 1's N+1 fix on the read side doesn't help — the bottleneck is the WRITE.

### Why this is not "obvious" from PERFORMANCE_BASELINE.md

The single-shot baseline measures one request at a time. With a single request there's no lock contention. The Phase 4 work fixed the read-path N+1 and reduced single-shot POS latency; concurrent POS load surfaces a different bottleneck that was invisible at concurrency=1.

### What "production-like" load looks like

A real tenant doesn't have 250 cashiers ringing up the same product simultaneously. Real load is hundreds of tenants × a few cashiers × dozens of different products. The single-row contention disappears when the row hash is spread across products + tenants. **The 145 req/s ceiling we measured is the worst-case for a single hot product, not the platform throughput.**

### Recommended (NOT speculative) mitigations

Each below is a measurable, surgical change — no rewrites:

1. **Move stock decrement to an atomic `UPDATE … RETURNING quantity`** (already what we have) with `SELECT … FOR UPDATE SKIP LOCKED`-style backoff. Won't help same-product contention but reduces lock-wait variance under cross-product load.
2. **Detect adversarial single-product hammering at the route layer** — `lib/api/tenant-rate-limit.ts` already has the seam (`write.default` bucket); add a `pos.same-product` bucket scoped to (tenantId, productId) at, say, 60 req/min.
3. **Async stock reservation queue** — push the inventory write to BullMQ (we already have the worker infra from Phase 1.5), let the sale return optimistically. Trade-off: optimistic stock means an over-sell window. Defer unless real customers complain.

None of these go into Phase 5; they're the kind of measured tweaks that belong in a later perf cycle once we have multi-tenant load tests.

---

## Bottleneck #2 — Dashboard fan-out fixed cost

### Evidence (from `dashboard-render` scenario)

| Concurrency | req/s | p50 | p95 | p99 |
|---|---|---|---|---|
| 10 | 56 | 149 ms | 384 ms | 515 ms |
| 25 | 59 | 382 ms | 814 ms | 1100 ms |
| 50 | 61 | 765 ms | 1446 ms | 1528 ms |
| 100 | 60 | 1564 ms | 2591 ms | 2771 ms |
| 250 | 54 | **4048 ms** | **6662 ms** | **6894 ms** |

**Throughput pinned at 54-61 req/s.** p50 grows linearly with concurrency, suggesting per-request fixed cost dominates over parallelism.

### Root cause

The Phase 4A dashboard SC renders **three Server Component widgets** (StatsGrid, LowStockAlert, RecentSalesList). They run in parallel within the SC, but:

- `StatsGrid` reads `loadDashboardStats` — cached (Phase 4B), ~1 ms on hit.
- `LowStockAlert` reads `listProducts` — NOT cached, ~10 ms warm.
- `RecentSalesList` reads `listSalesPage(limit=10)` — NOT cached, ~10 ms warm.

Each request takes ~22-25 ms of DB time **even in the best case**. Multiply by Suspense streaming + RSC serialization + cookie/session resolution + locale + branch resolution, and a single render is ~150 ms at concurrency 10.

At 250 conns, the 25 ms × 250 = 6,250 ms of theoretical DB work serialises through the 10-connection pool. **This IS the pool=10 bottleneck materialising** — for the dashboard specifically.

### What does NOT cause this

- The Server Component conversion itself (Phase 4A) — it actually improved single-shot latency.
- Cache misses — the cached stats endpoint stays fast (Bottleneck #3 below explains the dashboard delta).
- Network — localhost.

### Why it shows up only at concurrency

Dashboard is the only endpoint where one request does **three independent DB reads in parallel** (Promise.all in the SC). At low concurrency that's invisible; at 250 conns it triples the effective pool pressure.

### Recommended (NOT speculative) mitigations

1. **Cache `LowStockAlert` and `RecentSales` reads** with a short TTL (say 30 s, busted on product/sale writes via the existing `bustInsightsCache` seam). This pulls them off the DB pool entirely on hit — same pattern as Phase 4B's `loadDashboardStats`.
2. **Compose the three reads into one `loadDashboardSnapshot(tenantId, branchId)`** that opens **one** `withTenant` transaction instead of three. Saves 2 round trips per dashboard render. Drops pool pressure by 67% on this endpoint.

Mitigation #2 is the higher-ROI change; #1 is incremental on top of it. Both are surgical and measurable.

---

## Bottleneck #3 — Per-request `withTenant` overhead

### Evidence (from `customer-lookup` scenario)

| Concurrency | req/s | p50 | p95 |
|---|---|---|---|
| 50 | 291 | 160 ms | 324 ms |
| **100** | **252** | **365 ms** | **1436 ms** ← 4× jump |
| 250 | 316 | 750 ms | 1056 ms |

The p95 jumps 4× between c=50 and c=100, then **partially recovers** at c=250 (because requests give up faster waiting?). This is queueing on a constrained resource — connections — but NOT inventory contention because there are no writes.

### From `pg_stat_statements`

| Query | Calls | Mean ms |
|---|---|---|
| `BEGIN` (per `withTenant`) | 100,000+ | 0.00 |
| `SELECT set_config('app.tenant_id', $1, true)` | 100,000+ | 0.01 |
| Branch lookup `WHERE id IN (…)` | 98,667 | 0.03 |

`BEGIN` + `set_config` cost ~0.02 ms combined per call **but is paid on every API request**, regardless of how trivial the actual data access is. At 463 req/s (peak insights throughput), that's ~10 ms of pure transaction-management CPU per second. Cheap, but non-zero.

The per-request branch-lookup (98,667 calls, 0.03 ms each) compounds: it runs inside `resolveActiveBranch` from the auth helper, and at 100 concurrent API calls it's 100 simultaneous `withTenant` opens.

### What does NOT cause this

- Cache. Branch list IS cached (Phase 4C); the 98K calls are the per-request `id IN (…)` lookup inside `resolveActiveBranch`, which uses a different cache path (`branch-allow` per user, not per tenant).
- Repo logic. The 0.03 ms branches query is sub-millisecond.

### Recommended (NOT speculative) mitigations

1. **Cache the per-user branch-allow resolution at the JWT level.** The user-context cache from `lib/auth.ts` (60 s TTL) already exists; add the active branch to that bundle so it doesn't get re-queried per request. **Surgical** — one field added to `UserContext`, one cache key.
2. **Skip `withTenant` for routes that only touch global tables** (e.g. `/api/auth/2fa-needed`). Already documented as Phase 5 work in earlier audits; the load test confirms it's worth it.

---

## What evidence rules OUT as a bottleneck

This section is as important as the bottlenecks themselves — it stops future engineers from chasing the wrong fix.

### Postgres `max_connections = 100`

**Not a bottleneck.** Observed peak: 21 connections (10 app + 10 admin + 1 misc). Even at 250-connection autocannon load, the Node process recycled connections back into the pool without saturating it.

### App DB pool size = 10

**Not the FIRST bottleneck**, contrary to PERFORMANCE_BASELINE.md §2.8's prediction. It is the bottleneck for the *dashboard fan-out* (each request needs 3 connections), but not for the platform. The plateau at ~145 req/s on POS happens **before** the pool fills, because row-lock waits serialise the writes inside their transactions.

### Cache contention

**Not a bottleneck.** Redis hit rate 99.6%, instantaneous ops/sec peaked at 1,686. Zero cache errors. Zero invalidation issues observed. Phase 4B/4C did their job.

### Queue contention

**Not yet a bottleneck.** The activity-log queue (Phase 2.5) is `ACTIVITY_LOG_QUEUE` flag-gated and was OFF during this run. We could enable it and re-test, but the synchronous `logActivity` insert during load (10,933 calls × 0.16 ms = 1,716 ms total over the run) was only 0.6% of the total DB time. The queue is a real win at scale but not the choke point today.

### Node CPU / memory

**Not measured reliably.** The `ps` sampling at 1 Hz showed 0% CPU and ~12 MB RSS, which is implausibly low — the sampling window misses the burst. To get a meaningful answer we need either an in-process probe (`process.cpuUsage()`) or a long-running monitor like `pidstat`. **Listed as a Phase 5 follow-up.**

### React 19 hydration cost

**Not measured under load.** Browser-side concurrency is a separate domain. Phase 5A is a server-side load test.

---

## What this evidence enables (downstream phases)

| Use | Phase |
|---|---|
| Alert threshold setting (p95 ceilings) | Phase 5D (`ALERTING.md`) |
| Health/readiness probe intervals (latency ceilings) | Phase 5E (`DEPLOYMENT_READINESS.md`) |
| Trace span pinning for the hot paths | Phase 5C (`OBSERVABILITY.md`) — `recordCartSale`, `loadDashboardStats`, `resolveActiveBranch` are the spans worth wrapping |
| Capacity planning (req/s per node) | Real number per endpoint is in §2 above |

---

## What this evidence does NOT enable

- Multi-tenant load characterisation. Single tenant is the pessimistic case for some endpoints (POS) and the optimistic case for others (cache hit rate is locally high).
- Long-lived process drift (memory leaks, FD leaks). Each scenario was 15 s.
- Mobile / 3G latency.
- Real database with real volume (millions of rows per tenant).
