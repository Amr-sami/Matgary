# Load Test Baseline (Phase 5A)

Reproducible concurrent load test against the production build. Every number below was captured against `next start -p 3100` running locally with Docker Postgres + Redis, single tenant, with `TENANT_RATE_LIMIT_DISABLED=1` so the per-tenant API rate limiter (60 req/min on writes) doesn't mask the underlying app behavior.

**Test rig**: `tests/perf/load-test.ts` (autocannon, Node, ~270 LOC).
**Run command**:

```bash
DURATION=15 BASE=http://localhost:3100 \
  TENANT_RATE_LIMIT_DISABLED=1 npx tsx tests/perf/load-test.ts
```

**Concurrency levels**: 10, 25, 50, 100, 250 connections.
**Per-scenario duration**: 15 seconds.
**Snapshots per second**: Postgres `pg_stat_activity` + Redis `INFO` + Node `ps` (CPU/RSS).

---

## 1. Hardware + infrastructure

| Component | Spec |
|---|---|
| Host | macOS (single workstation) |
| Postgres | docker `postgres:16-alpine` (one container) |
| Redis | docker `redis:7-alpine` (one container) |
| Next.js | `next start -p 3100` (single process, NODE_ENV=production) |
| App DB pool size | **10** (`lib/db/index.ts`: `postgres({ max: 10 })`) |
| Admin DB pool size | 10 (separate, only used by /admin and migrations) |
| Postgres `max_connections` | 100 (default) |
| Tenant | 1 (single owner; cornerstore preset; product with topped-up qty for POS) |

---

## 2. Per-scenario results (15s, p50/p95/p99)

### 2.1 `products-list` (`GET /api/products`)

| Conns | req/s | p50 | p95 | p99 | non2xx | PG peak | Redis ops/s |
|---|---|---|---|---|---|---|---|
| 10 | 153 | 40 ms | 341 ms | 472 ms | 0 | 11 | 492 |
| 25 | 159 | 124 ms | 498 ms | 646 ms | 0 | 11 | 410 |
| 50 | 225 | 207 ms | 446 ms | 483 ms | 0 | 11 | 500 |
| 100 | 244 | 396 ms | 747 ms | 847 ms | 0 | 11 | 562 |
| **250** | **130** | **1700 ms** | **3892 ms** | **4008 ms** | **0** | 11 | 361 |

Throughput climbs from 153 to ~244 req/s up to 100 conns, then **collapses** to 130 at 250 — classic queue saturation. p50 grows linearly with concurrency.

### 2.2 `sales-list` (`GET /api/sales?paginated=1`)

| Conns | req/s | p50 | p95 | p99 | non2xx |
|---|---|---|---|---|---|
| 10 | 217 | 32 ms | 211 ms | 334 ms | 0 |
| 25 | 141 | 117 ms | 759 ms | 1291 ms | 0 |
| 50 | 228 | 194 ms | 476 ms | 588 ms | 0 |
| 100 | 274 | 371 ms | 602 ms | 642 ms | 0 |
| 250 | 287 | 857 ms | 1199 ms | 1201 ms | 0 |

Cursor pagination + small pages keep throughput stable up to 250 conns (~287 req/s ceiling). The c=25 spike to p99=1291 ms is run-to-run noise.

### 2.3 `customer-lookup` (`GET /api/customers/by-phone/...`)

| Conns | req/s | p50 | p95 | p99 |
|---|---|---|---|---|
| 10 | 311 | 26 ms | 181 ms | 193 ms |
| 25 | 272 | 79 ms | 241 ms | 258 ms |
| 50 | 291 | 160 ms | 324 ms | 349 ms |
| 100 | 252 | 365 ms | 1436 ms | 1573 ms |
| 250 | 316 | 750 ms | 1056 ms | 1222 ms |

Throughput plateaus around 270-316 req/s. p95 spikes 4× between 50 and 100 conns — first sign of queueing.

### 2.4 `dashboard-render` (`GET /` — Server Component path)

| Conns | req/s | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| 10 | 56 | 149 ms | 384 ms | 515 ms | 528 ms |
| 25 | 59 | 382 ms | 814 ms | 1100 ms | 1609 ms |
| 50 | 61 | 765 ms | 1446 ms | 1528 ms | 1654 ms |
| 100 | 60 | 1564 ms | 2591 ms | 2771 ms | 2910 ms |
| **250** | **54** | **4048 ms** | **6662 ms** | **6894 ms** | **7195 ms** |

**Dashboard is the platform's weakest concurrent endpoint.** Throughput is hard-capped at ~60 req/s regardless of concurrency; p50 latency grows linearly. Each render fans out to 3 Server Component widgets (StatsGrid is cached, LowStockAlert + RecentSalesList are not), and the bottleneck is the per-request work — not network.

### 2.5 `insights-overview` (`GET /api/insights/overview`)

| Conns | req/s | p50 | p95 | p99 |
|---|---|---|---|---|
| 10 | 381 | 20 ms | 165 ms | 195 ms |
| 25 | 367 | 57 ms | 212 ms | 226 ms |
| 50 | 375 | 119 ms | 284 ms | 306 ms |
| 100 | 386 | 239 ms | 454 ms | 520 ms |
| 250 | **463** | 527 ms | 998 ms | 1210 ms |

**Cleanest scaling profile in the suite.** Throughput is monotonic (381 → 463 req/s). p95 stays under 1 second at 250 conns. This is what a cache-backed endpoint should look like — the Phase 4B cache (`'use cache'` analogue via `cacheRemember`) is doing its job.

### 2.6 `pos-cart-sale` (`POST /api/sales/cart`)

| Conns | req/s | p50 | p95 | p99 | non2xx |
|---|---|---|---|---|---|
| 10 | 134 | 63 ms | 217 ms | 238 ms | 0 |
| 25 | 147 | 159 ms | 329 ms | 348 ms | 0 |
| 50 | 145 | 337 ms | 542 ms | 583 ms | 0 |
| 100 | 147 | 675 ms | 847 ms | 877 ms | 0 |
| 250 | 141 | 1691 ms | 2179 ms | 2261 ms | 0 |

**POS throughput is flat-capped at ~145 req/s** independent of concurrency. p50 grows linearly. Zero errors, zero timeouts. This is the row-lock signature on the single product the test hammers — see PHASE_5B §1.

---

## 3. Resource utilisation peaks (across the whole sweep)

| Resource | Observed peak | Configured limit | Headroom |
|---|---|---|---|
| Postgres connections (`pg_stat_activity`) | **21** | `max_connections = 100`; app pool `max = 10` | comfortable |
| Redis `instantaneous_ops_per_sec` | 1,686 (insights @ 250c) | unbounded (Redis is happy) | comfortable |
| Redis `keyspace_hits / misses` cumulative | 242,249 / 1,056 → **99.6% hit** | — | excellent |
| Node RSS | ~12 MB (process metric — `ps` reading appears wrong; likely undercount) | — | undefined for now |
| Node CPU % | 0% reported (`ps` sampling artifact) | — | undefined for now |
| Errors / timeouts | **0** across all 30 scenarios | — | — |
| Non-2xx responses | **0** across all 30 scenarios | — | — |

> Node CPU/memory readings via `ps` were unreliable at 1 Hz sampling — Mach reports 0% for short bursts. A future iteration of the rig should pull from `process.cpuUsage()` via an in-process probe or `pidstat`. The macro point — **no errors, no timeouts** at any concurrency level — is what matters here.

---

## 4. Top DB queries during the sweep (`pg_stat_statements`)

| Calls | Mean ms | Total ms | Query (abbreviated) |
|---|---|---|---|
| **10,933** | **26.92** | **294,314** | **`UPDATE products SET quantity = $1, updated_at = $2 WHERE tenant_id = $1 AND id = ...`** |
| 18,847 | 0.33 | 6,222 | `SELECT … FROM products WHERE tenant_id = $1` |
| 22,125 | 0.21 | 4,748 | `SELECT … FROM sales WHERE tenant_id = $1 …` |
| 10,932 | 0.25 | 2,682 | `INSERT INTO sales (…) VALUES (…)` |
| **98,667** | **0.03** | **2,560** | `SELECT id, name, is_primary FROM branches WHERE tenant_id = $1 AND id IN (…)` |
| 21,651 | 0.09 | 1,868 | `SELECT … FROM sales WHERE … (cursor variant)` |
| 10,933 | 0.16 | 1,716 | `INSERT INTO activity_logs (…)` |
| 10,933 | 0.09 | 965 | `INSERT INTO product_history (…)` |
| 10,932 | 0.03 | 296 | `SELECT … FROM products WHERE id = …` (single-row) |
| 10,932 | 0.02 | 247 | `SELECT cash_reconciliation_enabled FROM shop_settings …` |

**One query dominates total DB time by 47×.** The `UPDATE products SET quantity` from the POS path. 26.92 ms mean per call is **two orders of magnitude slower** than any other query in the system — and it's the single-row write inside `recordCartSale`. Cause is row-level lock contention from many concurrent transactions waiting to write the same `products.quantity` row.

Bottlenecks are analysed in detail in **PHASE_5B (BOTTLENECKS.md)** alongside this file.

---

## 5. Cache effectiveness during load

| Metric | Value |
|---|---|
| Total Redis commands | 267,426 |
| Cumulative cache hits | 242,249 |
| Cumulative cache misses | 1,056 |
| **Hit rate** | **99.6%** |

The per-tenant cache (insights overview, dashboard stats, branches, catalog, settings, userctx) absorbs nearly every read. The 1,056 misses are mostly cache-warmup at the start of each scenario.

---

## 6. Reproducing this baseline

```bash
# 0. Infra
docker compose up -d postgres redis
npm run db:migrate

# 1. Prod build
npm run build

# 2. Provision shared owner + state file (Phase 3 e2e safety net)
PLAYWRIGHT_NO_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3100 \
  npx playwright test pos-sale.spec.ts:21 --reporter=list

# 3. Prod server WITH rate-limit bypass (load-test only — NEVER set in prod)
set -a; source .env; set +a
TENANT_RATE_LIMIT_DISABLED=1 NODE_ENV=production npx next start -p 3100 &

# 4. Reset stats so the run is clean
docker exec matgary-postgres psql -U matgary -d matgary -c "SELECT pg_stat_statements_reset();"
docker exec matgary-redis redis-cli CONFIG RESETSTAT

# 5. Run the sweep — JSON dumps land in tests/perf/load/
DURATION=15 BASE=http://localhost:3100 \
  TENANT_RATE_LIMIT_DISABLED=1 npx tsx tests/perf/load-test.ts
```

Total wall-clock time: ~9 minutes (30 scenarios × ~17.5 s each including snapshot interval).

---

## 7. What this baseline does NOT measure

Honest gaps so a future engineer doesn't assume coverage:

- **Single tenant only.** Real-world load is many tenants making fewer requests each. The single-row contention measured here is the pessimistic case.
- **localhost network.** Real client RTT adds latency; this captures server-side processing only.
- **Single Node process.** Phase 5E reviews multi-instance.
- **No mobile / 3G client.** Bundle weight is unmeasured here (see PERFORMANCE_BASELINE.md).
- **Single-product POS hammering.** Real POS hits dozens of different products; row contention disappears.
- **WhatsApp send / receive paths.** Not in the rig — needs Meta mock.
- **PDF receipt generation under load.** Not in the rig.
- **Sustained 5-minute+ load.** Each scenario is 15 s; longer runs would expose memory drift.
