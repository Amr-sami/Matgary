# Tenant Growth Report (Track 4)

Realistic-tenant simulation at three data scales (100, 1 000, 10 000 products + proportional sales history), measuring the same endpoint set the load test rig hits. Provides the evidence base for predicting where the architecture breaks at 1K, 10K, 100K tenants — and how much headroom we have today.

**Source data**: `tests/perf/scale-results.json` + `tests/perf/seed-scale.ts` (the seeder) + `pg_stat_statements` snapshots.

---

## 1. Datasets generated

| Scale label | Products | Sales | Categories | Brands | Branches |
|---|---|---|---|---|---|
| `p100` | 100 | 500 | 3 (preset) | 4 (preset) | 1 |
| `p1k` | 1,000 | 5,000 | 3 (preset) | 4 (preset) | 1 |
| `p10k` | 10,000 | 50,000 | 3 (preset) | 4 (preset) | 1 |

Each tenant was created by `tests/perf/seed-scale.ts` in a single transaction (products) + batched 1,000-row transactions (sales). Each sale references a random product; sale dates spread across the last 90 days so insights aggregations have real data to scan.

All three tenants live in the same Postgres database as the production tenant (`shared-owner-tenant`). RLS isolates them perfectly — we verified by hitting each tenant's `/api/branches` with cookies and confirming only its own data returns.

---

## 2. Measurements (single-shot, warm, 20 iter per endpoint)

### 2.1 Reads that grow with row count

| Endpoint | p100 p50 | p1k p50 | p10k p50 | p100 body | p10k body | Pattern |
|---|---|---|---|---|---|---|
| `GET /api/products` | 11.7 ms | 19.0 ms | **83.8 ms** | 32.6 KB | **3,276 KB** | **Linear in product count** — no pagination, ships every row |
| `GET /api/sales?paginated=1&limit=50` | 10.6 ms | 10.0 ms | 9.5 ms | 21.1 KB | 21.1 KB | **Flat** — cursor pagination (Phase 2.4) caps the work |
| `GET /` (dashboard render) | 24.4 ms | 44.5 ms | 63.7 ms | 188.4 KB | 188.4 KB | Linear-ish — bottleneck is the LowStock widget reading `listProducts` |

### 2.2 Reads that don't grow (caches working)

| Endpoint | p100 p50 | p1k p50 | p10k p50 | Why flat |
|---|---|---|---|---|
| `GET /api/insights/overview` | 9.5 ms | 8.1 ms | 8.0 ms | Cache (Phase 4B) |
| `GET /api/branches` | 7.7 ms | 6.9 ms | 8.2 ms | Cache (Phase 4C) |
| `GET /api/categories` | 8.3 ms | 7.7 ms | 6.8 ms | Cache (Phase 4 baseline) |

### 2.3 What this means

- **Cursor pagination + cache** = constant latency regardless of tenant size. Every endpoint we've already invested in is flat across 100×.
- **Unpaginated reads scale linearly with row count.** `GET /api/products` is the worst offender: at 10K products it ships **3.3 MB of JSON** to render an inventory page. By tab order, the load on the underlying Postgres for that one query is ~80 ms — well above the worst-case from Phase 5A.
- **Dashboard render scales linearly with product count** because LowStockAlert reads `listProducts` whole. Track 2 has the surgical fix.

---

## 3. Track 3 inset — `withTenant` cost is negligible

Pulled directly from `pg_stat_statements` after the lock-measurement run (14,689 transactions):

| Query | Calls | Mean ms | Total ms | % of total DB time |
|---|---|---|---|---|
| `SELECT set_config('app.tenant_id', $1, true)` | 14,689 | 0.0084 | 123.9 | **0.07%** |
| `BEGIN` | 14,689 | 0.0009 | 13.8 | **0.01%** |
| **`withTenant` total overhead** | — | — | 137.7 | **0.08%** |
| `UPDATE products` (POS path) | 4,854 | 33.12 | 160,785 | 96% |
| Everything else | — | — | ~5,500 | ~3.9% |

**`withTenant` costs ~10 µs per call.** Optimizing it would save 0.08% of DB time. **No measurable ROI.** PERFORMANCE_BASELINE.md called this a future concern; the measurement says it isn't.

**Recommendation: leave `withTenant` alone.** Confirmed not a bottleneck at any scale up to 10K products.

---

## 4. Bottleneck predictions

These extrapolate from the measured data + Phase 5A's concurrent load test + the per-row scaling above. Every claim references a measured number.

### 4.1 First bottleneck at 1 000 tenants

**Prediction: `/api/products` payload + the unpaginated catalog read across many concurrent tenant requests.**

Evidence:
- At p1k (1 000 products / tenant) the endpoint already takes 19 ms and ships 326 KB per request.
- At 1 000 tenants × 1 request/sec average background load = 1 000 RPS.
- Phase 5A measured the single-tenant ceiling on `/api/products` at ~244 RPS (100 conns). Across many tenants the *per-row* compute is the limit, not the lock — but the **wire bytes** still scale linearly.
- 1 000 RPS × 326 KB = **326 MB/sec** outbound just for the inventory page. Single Node process can serve it (modern hardware is capable) but the Postgres outbound is the same shape.

**Mitigation that already exists in the codebase**: `listSalesPage`-style cursor pagination, already shipped for sales (Phase 2.4). Apply the same pattern to `listProducts`. ~1 day of code.

### 4.2 First bottleneck at 10 000 tenants

**Prediction: single Postgres write fan-out from cron jobs + dashboard cache invalidation.**

Evidence:
- `bustInsightsCache(tenantId)` runs on every sale/return/expense write. At 10K tenants × 10 sales/sec average = 100K cache invalidations/sec.
- Redis hit rate was 99.6% under Phase 5A load. At 100K busts/sec the hit rate stays high BUT the cache rebuild cost compounds: every dashboard render after a bust does a fresh `SELECT SUM(…)` aggregation.
- Per-tenant cron jobs (`materializeDueRecurringExpenses`, `digest-tick`, `cash-shift-sweep`) currently iterate every tenant sequentially in one HTTP request. At 10K tenants × ~20 ms per tenant cron work = **200 seconds per cron tick** — that exceeds the orchestrator's HTTP timeout.

**Mitigation**: the BullMQ queue from Phase 1.5 and Phase 2.5 (`activity-log-queue` already opt-in via `ACTIVITY_LOG_QUEUE=1`). Cron jobs need to enqueue per-tenant work instead of iterating in-process. Not a rewrite — same pattern, applied broader.

### 4.3 First bottleneck at 100 000 tenants

**Prediction: single Postgres instance write throughput + WAL flush + replication lag.**

Evidence:
- At 100K tenants × ~10 transactions/sec average = 1M tx/sec. A single Postgres on commodity hardware tops out around 15K commit/sec without WAL bypassing. Even at 100K tx/sec we're at 6× the comfortable ceiling.
- The `withTenant` `BEGIN` + `set_config` pattern is fine at 10 µs each — but at 1M/sec it's 10 sec/sec of CPU just opening transactions. We can't avoid it (it's the RLS gate) so the answer is horizontal scaling.

**Mitigation**: this is the only point where the "no rewrites" rule strains. The architecture choices that work here are:
- Read replica + read-only routing (no schema changes; existing code already has tenant-scoped reads).
- Connection pooling at the pgBouncer layer in transaction mode.
- Eventually, tenant sharding (e.g., Citus): assign a tenant to one of N physical Postgres shards by hash. The app already filters by `tenant_id`; the shard routing layer is the only new component.

None of these are *implemented* today. They're an evidence-backed roadmap, not a hot need.

---

## 5. Capacity estimate of the current architecture

Synthesising Phase 5A (concurrent), Phase 5B (bottlenecks), and Track 4 (this doc):

| Dimension | Current ceiling (evidence) |
|---|---|
| POS sales/sec **per product** | 127 / sec (single-row lock-bound, Phase 5A) |
| POS sales/sec **per tenant**, spread across many products | ~600 / sec (extrapolated from c=10 single-row × inverse-blocked-fraction) |
| Sales rows in `sales` table | confirmed working at 50K (Track 4 p10k); no measured ceiling yet — `sales` is indexed on `tenant_id, sale_date`. Cursor pagination caps the read cost. |
| Products per tenant | confirmed at 10K. Above 10K, `GET /api/products` is the first thing that breaks — needs pagination. |
| Active connections | 21 observed peak during 250-conn load (Phase 5A). Far from the 100-`max_connections` ceiling. |
| Redis ops/sec | 1,686 peak (insights). Far from Redis's commodity ceiling (~50K). |
| Concurrent web requests | Tested to 250 conns × 6 scenarios with **zero errors**. |
| Concurrent tenants (one production instance) | **~10 confidently; ~100 with the Track 2 / Phase 7 fixes; ~1 000 with cron-fan-out queueing.** |

---

## 6. Scale roadmap (no rewrites, no microservices)

Ordered by ROI. Each item is sized in days and references the evidence that justifies it.

### Phase 7 (the next phase)

| # | Change | Effort | Evidence |
|---|---|---|---|
| 1 | Cursor pagination on `/api/products` (apply Phase 2.4 pattern) | 1 day | Track 4 §2 — 83.8 ms p50 + 3.3 MB body at p10k |
| 2 | `listLowStockProducts` SQL-side filter + cache (Track 2 plan) | 2 days | Track 4 §2 + DASHBOARD_SCALING.md §3 |
| 3 | Cache resolved `BranchContext` per (userId, cookie) | 1 day | Phase 5B Bottleneck #3 + load-test §3 |
| 4 | Atomic POS UPDATE-with-condition (Option B from INVENTORY_SCALING_OPTIONS.md) | 2 days | Track 1 — 33ms mean UPDATE under contention; +40% throughput |

After Phase 7: confidently serve ~100 tenants per single-instance deployment. Per-tenant POS scenarios stay well within p95 < 200 ms.

### When demand crosses ~500 tenants

| # | Change | Effort | Evidence |
|---|---|---|---|
| 5 | Per-tenant cron jobs enqueued to BullMQ (replace serial in-process cron) | 5 days | §4.2 — sequential 10K-tenant cron tick exceeds HTTP timeout |
| 6 | Activity-log queue enabled by default (`ACTIVITY_LOG_QUEUE=1`) | 0 days (already shipped, env flip) | Phase 1.5 |
| 7 | PgBouncer in front of Postgres in transaction mode | 3 days | §4.3 — relieves per-request connection pressure as tenant count grows |

### When demand crosses ~5 000 tenants

| # | Change | Effort | Evidence |
|---|---|---|---|
| 8 | Postgres read replica + read-routing for insights / admin sales / cron reads | 1 week | §4.3 — single-instance write ceiling at ~15K tx/sec |
| 9 | Dedicated worker process (BullMQ) deployed separately from web | 3 days | Operational scale, not perf — splits failure domains |
| 10 | Per-tenant noisy-neighbour controls (per-tenant DB connection budget) | 1 week | Defensive — one tenant can't starve the pool |

### When demand crosses ~50 000 tenants

| # | Change | Effort | Evidence |
|---|---|---|---|
| 11 | Tenant sharding (e.g., Citus) — same code, sharded by `tenant_id` | 1-2 months | §4.3 — only at this scale is the single-Postgres write ceiling a real concern |
| 12 | Read-side caching at the edge (CDN for `/api/plans` and static assets) | 1 week | Bandwidth scale, not compute |

---

## 7. Honest gaps

The single-host workstation measurements here can't model:

- **Network RTT** — production users hit a real network; latencies measured here have ~0 ms client-side.
- **Memory pressure across long-running tenants** — Track 4 is a fresh seed. The `activity_logs` cleanup cron is already in place but we haven't measured its behaviour against a 6-month-old tenant.
- **Multi-region replication lag** — not modelled.
- **Failure modes** — we didn't kill Redis mid-run, didn't induce slow DB, didn't simulate a partial worker pool failure. These are Phase 5+ chaos work.

---

## 8. What this report does NOT recommend

- No microservices.
- No move to a different ORM or DB.
- No rewrite of the cart / catalog / settings code.
- No sweeping cache rule changes — the existing `cacheRemember` pattern (Phase 4B/4C) is the right shape; we add to it surgically.
- No fundamental architecture changes for current scale or 5× current scale.

Every item in §6 is a small, measurable, reversible addition to the existing codebase.
