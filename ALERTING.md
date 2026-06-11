# Alerting (Phase 5D)

Concrete thresholds derived from the Phase 5A load test (`LOAD_TEST_BASELINE.md`) and the Phase 5B bottleneck evidence (`BOTTLENECKS.md`). No values are speculative — each number references the run row it came from.

**Format**: every alert is one row. Columns: `name | metric | threshold (warning) | threshold (critical) | for-duration | source | what-to-do`.

The thresholds assume one production tenant doing realistic traffic — not the synthetic worst-case (single product hammered by 250 cashiers). For multi-tenant production, the same numbers apply per-tenant; bumping them globally hides hotspots.

---

## 1. API latency alerts

### 1.1 POS write path

| Field | Value |
|---|---|
| Name | `pos_cart_p95_slow` |
| Metric | p95 latency of `POST /api/sales/cart`, 1-minute window |
| Warning | > **500 ms** for 5 min |
| Critical | > **1 000 ms** for 2 min |
| For-duration | 5 min (warn) / 2 min (crit) |
| Source | Phase 5A: at 50 conns p95 was 542 ms; at 100 conns 847 ms. Bottleneck #1: row-lock on `products.quantity`. |
| What to do | Check `pg_stat_statements` for the `UPDATE products` query mean. If > 5 ms, identify the hot product via `pg_locks` JOIN `pg_stat_activity`. Per-product rate limit (PHASE 5B mitigation #2) is the fix. |

### 1.2 Dashboard render

| Field | Value |
|---|---|
| Name | `dashboard_p95_slow` |
| Metric | p95 latency of `GET /`, 1-minute window |
| Warning | > **800 ms** for 5 min |
| Critical | > **2 000 ms** for 2 min |
| Source | Phase 5A: at 50 conns dashboard p95 was 1 446 ms — already at the warning level under modest load. Bottleneck #2: fan-out + uncached LowStock/RecentSales reads. |
| What to do | Check OTEL trace for the `repo.dashboard.stats` span — should be < 5 ms on cache hit. If slow, Redis is degraded. Mitigation: cache the two remaining widgets (Phase 5B §2). |

### 1.3 Insights overview

| Field | Value |
|---|---|
| Name | `insights_p99_slow` |
| Metric | p99 latency of `GET /api/insights/overview`, 1-minute window |
| Warning | > **300 ms** for 5 min |
| Critical | > **1 000 ms** for 2 min |
| Source | Phase 5A: at 250 conns p99 was 1 210 ms. Single-shot p99 was 10 ms (Phase 4B). A p99 > 1 s means the cache is missing — investigate Redis. |

### 1.4 Generic API latency (catch-all)

| Field | Value |
|---|---|
| Name | `api_p95_high` |
| Metric | p95 latency of any 2xx `/api/*` route, 5-minute window |
| Warning | > **1 000 ms** for 10 min |
| Critical | > **3 000 ms** for 5 min |
| Source | Phase 5A `customer-lookup` at 100 conns hit 1 436 ms p95 — that's the practical ceiling we should warn at. |

---

## 2. Error-rate alerts

### 2.1 5xx error rate

| Field | Value |
|---|---|
| Name | `api_5xx_rate` |
| Metric | rate of HTTP 5xx responses ÷ total responses, 5-minute window |
| Warning | > **0.5%** for 10 min |
| Critical | > **2%** for 5 min |
| Source | Phase 5A: 0 errors across 30 scenarios. Anything > 0.5% is a real incident. Pre-Phase-1 baseline (Arabic strings becoming 500s) would have set this off constantly; the DomainError + 4xx refactor closed that class. |
| What to do | Sentry will already have the stack. Check the error class — if `DomainError`, it slipped through a route that didn't import the handler. If `INTERNAL`, treat as a real bug. |

### 2.2 4xx rate (signal for client bugs / under-attack)

| Field | Value |
|---|---|
| Name | `api_4xx_rate` |
| Metric | rate of HTTP 4xx ÷ total, 5-minute window, EXCLUDING 401 + 429 |
| Warning | > **5%** for 10 min |
| Critical | > **15%** for 5 min |
| Source | 401 + 429 are healthy backpressure signals; excluding them isolates real client bugs. |
| What to do | Look for one error code dominating (e.g. `INSUFFICIENT_STOCK` 80% of 4xx → product mis-priced). |

### 2.3 401 rate (credential stuffing / cookie leak)

| Field | Value |
|---|---|
| Name | `auth_failure_rate` |
| Metric | rate of HTTP 401 from a single IP, 5-minute window |
| Warning | > **20 / min** for one IP |
| Critical | > **100 / min** for one IP |
| Source | The Auth.js per-IP login limit (`LOGIN_IP_LIMIT = 10` / 15 min in `lib/auth.ts`). Anything > 20/min sustained from one IP means automated attempts beyond the limiter — could indicate distributed attack or limiter outage. |

### 2.4 429 rate (per-tenant rate limit hit)

| Field | Value |
|---|---|
| Name | `tenant_rate_limit_hit` |
| Metric | rate of HTTP 429 from one tenant, 5-minute window |
| Warning | > **20** in 10 min |
| Critical | > **100** in 5 min |
| Source | `logger.warn({event: "tenant.rate_limit.blocked", ...})` in `lib/api/tenant-rate-limit.ts`. Phase 2 default buckets — 60/min write, 120/min read. Tenant hitting these = runaway integration or POS automation. |
| What to do | If the tenant is real and the workload is legitimate, raise their bucket. If it's a leaked-cookie attack, rotate the owner's token (`users.tokenVersion` bump). |

---

## 3. Queue alerts (BullMQ — `wa-jobs` + `activity-log`)

### 3.1 WhatsApp queue depth

| Field | Value |
|---|---|
| Name | `wa_queue_backlog` |
| Metric | `wa-jobs` BullMQ `waiting` count |
| Warning | > **500** for 10 min |
| Critical | > **2 000** for 5 min |
| Source | At 1 worker × ~10 ms per `outbound.text` job = ~6 000 jobs/min. Backlog > 2 000 = 20 s+ user-visible delay. |
| What to do | Spin up another worker process. The bootstrap code is in `lib/whatsapp/worker-bootstrap.ts`; scale by running additional Node instances with the same `REDIS_URL`. |

### 3.2 WhatsApp dead-letter

| Field | Value |
|---|---|
| Name | `wa_queue_dead` |
| Metric | `wa-jobs` `failed` count |
| Warning | > **10 / hour** |
| Critical | > **100 / hour** |
| Source | Phase 1.5 set `removeOnFail: 50` — anything above that is real, not jitter. |
| What to do | Drain the DLQ via the Bull dashboard; investigate the Meta error in `wa_messages.errorMessage`. |

### 3.3 Activity-log queue (opt-in)

Only fires when `ACTIVITY_LOG_QUEUE=1` is set.

| Field | Value |
|---|---|
| Name | `activity_queue_backlog` |
| Metric | `activity-log` `waiting` count |
| Warning | > **1 000** for 5 min |
| Critical | > **5 000** for 2 min |
| Source | At 4 concurrency × ~5 ms per insert = ~50 000 jobs/min capacity. Backlog > 5 000 means audit writes are 6+ seconds behind reality — observability gap. |

---

## 4. Redis alerts

### 4.1 Hit rate degradation

| Field | Value |
|---|---|
| Name | `cache_hit_rate_low` |
| Metric | `keyspace_hits / (keyspace_hits + keyspace_misses)` over 5 min |
| Warning | < **90%** for 10 min |
| Critical | < **70%** for 5 min |
| Source | Phase 5A measured 99.6%. Phase 4B baseline 97.6%. A drop to 90% means a large invalidation event (good) OR a cache key bug (bad). Below 70% = Redis effectively useless. |

### 4.2 Connection saturation

| Field | Value |
|---|---|
| Name | `redis_clients_high` |
| Metric | `connected_clients` from `INFO clients` |
| Warning | > **150** |
| Critical | > **400** |
| Source | Default `maxclients = 10 000`. The app uses a single connection per process; > 150 means subscriber leaks (SSE notification stream rebinds) or cron-fan-out misconfiguration. |

### 4.3 Memory pressure

| Field | Value |
|---|---|
| Name | `redis_memory_high` |
| Metric | `used_memory_rss_human` from `INFO memory` |
| Warning | > **200 MB** |
| Critical | > **400 MB** |
| Source | `docker-compose.yml` already sets `maxmemory 256mb` + `allkeys-lru`. Critical threshold = container OOM imminent. |

### 4.4 Eviction rate

| Field | Value |
|---|---|
| Name | `redis_evictions` |
| Metric | rate of `evicted_keys` over 5 min |
| Warning | > **100 / min** |
| Critical | > **1 000 / min** |
| Source | `allkeys-lru` evicts under pressure — non-zero is OK. > 1 000/min means the working set exceeds 256 MB and cache hit rate WILL drop next. |

---

## 5. Database alerts

### 5.1 Connection saturation

| Field | Value |
|---|---|
| Name | `pg_connections_high` |
| Metric | `count(*) FROM pg_stat_activity WHERE datname='matgary'` |
| Warning | > **70** |
| Critical | > **95** |
| Source | Postgres `max_connections = 100` (default). App pool = 10 + admin pool = 10. Anything over 70 means a connection leak — likely a hung transaction. |

### 5.2 Long-running transaction

| Field | Value |
|---|---|
| Name | `pg_long_transaction` |
| Metric | `SELECT count(*) FROM pg_stat_activity WHERE state IN ('active', 'idle in transaction') AND now() - xact_start > interval '30 seconds'` |
| Warning | > **0** for 1 min |
| Critical | > **3** for 1 min |
| Source | The `withTenant` pattern opens short-lived transactions. Anything > 30 s = leak or row-lock wait. Phase 5B Bottleneck #1 manifests here under heavy POS contention. |

### 5.3 Slowest query mean

| Field | Value |
|---|---|
| Name | `pg_slow_query` |
| Metric | `MAX(mean_exec_time) FROM pg_stat_statements WHERE calls > 100` |
| Warning | > **20 ms** |
| Critical | > **100 ms** |
| Source | Phase 5A: the `UPDATE products` row-lock case ran at 26.92 ms mean — that's already past the warning. We KNOW this query is in contention; the alert fires when contention compounds. Critical = something's badly wrong. |

### 5.4 Replication lag (when we add a read replica)

Deferred — no replica today. Phase 5E discusses the multi-instance roadmap.

### 5.5 Disk free

| Field | Value |
|---|---|
| Name | `pg_disk_low` |
| Metric | `pg_database_size('matgary')` divided by the volume's free space |
| Warning | container disk > **70%** full |
| Critical | container disk > **90%** full |
| Source | `activity_logs` grows unbounded between the daily cleanup cron runs (2-year retention). At 1 K tenants × 100 K rows/month it's the first table to fill the disk. |

---

## 6. Process-level alerts

### 6.1 Node process restart

| Field | Value |
|---|---|
| Name | `node_restart` |
| Metric | container restart count, 10-minute window |
| Warning | > **0** |
| Critical | > **2** |
| Source | A clean `next start` should not restart. Restart = unhandled rejection past Sentry's catch, OOM, or container-level kill. |

### 6.2 Health probe failure

| Field | Value |
|---|---|
| Name | `readyz_failing` |
| Metric | HTTP status of `GET /readyz` |
| Warning | non-200 for 30 s |
| Critical | non-200 for 2 min |
| Source | `/readyz` checks DB + Redis with 1 s timeout. Non-200 = the orchestrator should pull the instance out of the LB. Critical = no instances are ready, page on-call. |

### 6.3 Sentry error spike

| Field | Value |
|---|---|
| Name | `sentry_error_burst` |
| Metric | count of new issues per hour |
| Warning | > **20 / hour** |
| Critical | > **100 / hour** |
| Source | Pre-DomainError refactor, user-error 500s noisied this. Post-refactor anything > 20/hr unique issues is a real regression. |

---

## 7. What we DON'T alert on (and why)

| Signal | Why not |
|---|---|
| CPU > X% on the Node process | Phase 5A's `ps` sampling was unreliable — alert would fire randomly. Use container-level cgroup metrics in production. |
| Memory > X MB on the Node process | Same. Use cgroup. |
| Specific Sentry error names | Already in Sentry's UI; alerting on individual issue names dilutes signal. |
| Per-cron-job success | Cron success/failure is tracked in `digest_runs` etc.; alerting on individual rows would page nightly on the first failure of a long-tailed retry. Use the queue + 5xx alerts instead. |
| Per-tenant latency anomaly | Single-tenant load test can't model multi-tenant variance. Re-evaluate when production has multiple tenants. |

---

## 8. Alert routing recommendations

| Severity | Channel |
|---|---|
| Critical | Page on-call (PagerDuty / OpsGenie) — anyone who can connect to prod within 5 min |
| Warning | Slack #ops with @here, ticket auto-created |
| Info / sanity | Daily digest only (no real-time noise) |

The platform-admin daily digest (`/api/cron/digest-tick`) is the right surface for "info" — same audience.
