# Observability (Phase 5C)

Concrete implementation of OpenTelemetry tracing wired through the three hot paths Phase 5B identified, plus the existing logging and Sentry infrastructure documented in one place.

**Scope of this phase**: tracing only (spans + attributes). Metrics + logs export to OTLP can be turned on with the same env vars but are not wired in code yet — Phase 5 deliverable is "request tracing, DB query tracing, Redis tracing", not a full metrics pipeline.

---

## 1. What's implemented

### 1.1 OpenTelemetry SDK

- **`instrumentation.ts`** (existing file, extended): registers `@vercel/otel` at Node startup when `OTEL_SERVICE_NAME` is set. Auto-detects OTLP collector via standard `OTEL_EXPORTER_OTLP_*` env vars. No collector → exporter is a no-op, no overhead.
- **Edge runtime** is unaffected (OTEL initialisation is gated to `NEXT_RUNTIME === "nodejs"`).
- **Dependencies added**: `@vercel/otel@^2.1.3`, `@opentelemetry/api@^1.x`.

### 1.2 Tracing helper

- **`lib/observability/tracing.ts`**: thin wrappers — `withSpan(name, attrs, fn)` and `withSpanSync(...)` — around `tracer.startActiveSpan`. Captures exceptions on the span, re-throws so caller behaviour is unchanged.
- When `OTEL_SERVICE_NAME` is unset (default in dev), `trace.getTracer()` returns a no-op tracer. The wrappers add ~0 overhead.

### 1.3 Wrapped hot paths (the three Phase 5B bottlenecks)

| Span name | Wraps | Attributes |
|---|---|---|
| `repo.sale.record_cart` | `recordCartSale` in `lib/repo/operations.ts` | `tenant_id`, `branch_id`, `cart.line_count`, `cart.payment_method` |
| `repo.dashboard.stats` | `loadDashboardStats` in `lib/repo/insights.ts` | `tenant_id`, `branch_id` |
| `api.branch.resolve_active` | `resolveActiveBranch` in `lib/api/branch-context.ts` | `tenant_id`, `user_id` |

Each chosen because the load test showed it sitting on the critical path of the platform's three most concurrent endpoints (POS, dashboard, every authenticated request).

### 1.4 What `@vercel/otel` auto-instruments

By default the package installs instrumentation for:
- **`next/http`** — every Server Component, Server Action, and route handler gets a root span.
- **`fetch`** — outbound HTTP calls (we deliberately do NOT enable per-fetch breakdown because Sentry already breadcrumbs them).
- **Node `http` / `https`** — for any non-fetch outbound traffic.

Drizzle does NOT have native OTEL instrumentation. The DB-query spans rely on `pg_stat_statements` for aggregate analysis (Phase 5A / `BOTTLENECKS.md`). For per-trace DB visibility, callers should wrap individual repo calls with `withSpan` — the three above are the highest-value ones.

### 1.5 Redis tracing

Redis (ioredis) does NOT have OTEL instrumentation in `@vercel/otel`. The existing `lib/cache.ts` is the canonical surface and has explicit `[cache] HIT/MISS` logging via the `CACHE_DEBUG=1` env. For distributed traces, the `cacheRemember` callsites in repos that we DO wrap (`loadDashboardStats`) will show the time spent inside the cache lookup as part of the parent span. Adding granular per-cache-op spans would inflate the trace for marginal value — deferred.

### 1.6 Existing observability that DIDN'T change

Phase 5C is additive. The following remain the canonical observability primitives:

| Layer | Implementation | File |
|---|---|---|
| Structured logging | JSON line per call with auto-correlated `requestId` via AsyncLocalStorage | `lib/logger.ts` + `lib/request-context.ts` |
| Error capture | Sentry (server + edge + client) with scrubbed PII | `sentry.*.config.ts`, `lib/sentry/scrub.ts` |
| Request-error hook | `onRequestError` in `instrumentation.ts` | already shipped |
| Health probes | `GET /healthz` (uptime), `GET /readyz` (DB + Redis with 1 s timeout) | `app/healthz/route.ts`, `app/readyz/route.ts` |
| DB query stats | `pg_stat_statements` | migration `0039_pg_stat_statements.sql` |
| Cache stats | `redis-cli INFO stats` | manual |
| Per-tenant rate limit blocks | `logger.warn({ event: "tenant.rate_limit.blocked", ... })` | `lib/api/tenant-rate-limit.ts` |

---

## 2. Enabling traces in production

### 2.1 Minimum env vars

```bash
OTEL_SERVICE_NAME=matgary-web         # required to enable OTEL
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production,service.version=0.1.0
```

### 2.2 Pointing at a collector

The `@vercel/otel` defaults honour the standard OTLP env vars:

```bash
# OTLP/HTTP (default protocol)
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.your-domain.com:4318
OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer YOUR_TOKEN"

# OTLP/gRPC
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.your-domain.com:4317
```

Tested compatibility (per `@vercel/otel` docs): Honeycomb, Datadog, Grafana Tempo, Jaeger, Sentry tracing endpoint, Vercel Observability.

### 2.3 Local dev (Jaeger via Docker)

```bash
docker run -d --rm --name jaeger \
  -p 16686:16686 -p 4318:4318 \
  jaegertracing/all-in-one:latest

# In .env or shell:
OTEL_SERVICE_NAME=matgary-web
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

Open http://localhost:16686 → "matgary-web" service → see spans per request.

---

## 3. What you should see in a trace

For a single `POST /api/sales/cart` request from a real cashier:

```
HTTP POST /api/sales/cart           (root span — @vercel/otel)
├─ api.branch.resolve_active        (this phase)
│   ├─ tenant_id = …
│   └─ user_id  = …
└─ repo.sale.record_cart            (this phase)
    ├─ tenant_id        = …
    ├─ branch_id        = …
    ├─ cart.line_count  = 3
    ├─ cart.payment_method = "cash"
    └─ (Drizzle's actual SQL execution is NOT
        an OTEL span — it shows up as part of
        the parent's duration. Aggregate SQL
        stats live in pg_stat_statements.)
```

For a `GET /` dashboard render:

```
HTTP GET /                          (root span)
├─ api.branch.resolve_active        (this phase)
└─ Server Component render
    ├─ <StatsGridServer>
    │   └─ repo.dashboard.stats     (this phase — cache hit ~1 ms)
    ├─ <LowStockAlertServer>
    │   └─ (listProducts — uncached, ~10 ms warm)
    └─ <RecentSalesListServer>
        └─ (listSalesPage — uncached, ~10 ms warm)
```

Bottleneck #2 from `BOTTLENECKS.md` (dashboard fan-out) is visible directly: the LowStock and RecentSales branches don't have spans, so their work shows up as gap in the dashboard span. The mitigation (cache the dashboard snapshot) would close that gap.

---

## 4. Trace correlation with logs

Every log line emitted by `lib/logger.ts` carries `requestId` from `lib/request-context.ts` (Phase 1.5). When OTEL is enabled, the same request also has a `trace_id` from the OTEL SDK.

**Today**: the two IDs are not joined. The logger doesn't know about OTEL.

**Phase 5 follow-up** (5–10 lines of code): in `lib/logger.ts:emit()`, also read `trace.getActiveSpan()?.spanContext().traceId` and attach it as `trace_id`. Then log → trace correlation works out of the box in any UI that filters by `trace_id`.

We did NOT wire this in Phase 5C because:
1. It requires the OTEL API to be loaded before any log call — fine at runtime but adds a module-level import to a hot path.
2. It's measurable observability work that should follow its own PR with the trace_id presence visible in test fixtures.

---

## 5. What's deliberately NOT in this phase

| Feature | Why not |
|---|---|
| Metrics export (latency histograms, request counts) | Phase 5A's load-test rig already produces these locally. Adding a metrics pipeline duplicates that artefact. When we have a managed metrics backend, swap in. |
| Logs export to OTLP | The logger writes to stdout (12-factor); log shippers (Datadog Agent, Fluent Bit) pick it up. Native OTLP log export is the same work in a different format. |
| Per-fetch span breakdown | Sentry already breadcrumbs outbound fetches with timing. Duplicating in OTEL inflates the trace tree for marginal value. |
| Per-`cacheGet`/`cacheRemember` span | Cache time shows up inside the parent span (`repo.dashboard.stats`). Granular cache spans add ~1 µs per call × thousands of calls = real overhead for no diagnostic gain. |
| Drizzle query spans | No native instrumentation. Would require wrapping every repo function — explicit ROI < cost. `pg_stat_statements` answers the aggregate question; per-trace SQL visibility deferred until we hit a specific debugging need. |
| Cron job spans | The cron routes are server-rendered by Next so they get an auto root span. The work inside them (`materializeDueRecurringExpenses` etc.) could be wrapped — added when we observe a cron-related incident. |

---

## 6. Verifying OTEL works (smoke test)

```bash
# 1. Spin up Jaeger
docker run -d --rm --name jaeger -p 16686:16686 -p 4318:4318 \
  jaegertracing/all-in-one:latest

# 2. Build with OTEL on
npm run build

# 3. Start with the env vars set
OTEL_SERVICE_NAME=matgary-web \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
NODE_ENV=production npx next start -p 3100 &

# 4. Generate a sale (any path that calls recordCartSale)
PLAYWRIGHT_NO_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3100 \
  npx playwright test pos-sale.spec.ts:21 --reporter=list

# 5. Open http://localhost:16686 — pick service "matgary-web"
#    You should see traces with the three wrapped spans plus the
#    auto-injected HTTP root span.
```

If the spans show up with `tenant_id` / `branch_id` attributes, the wiring is correct. If not, check `OTEL_SERVICE_NAME` is set and the `@vercel/otel` module didn't fail to load (visible in stderr at boot).

---

## 7. Production hardening notes

1. **Sample rate**: by default `@vercel/otel` samples 100% of traces. For a busy tenant that's a lot of spans. Tune via `OTEL_TRACES_SAMPLER=parentbased_traceidratio` + `OTEL_TRACES_SAMPLER_ARG=0.1` for 10%.
2. **Sensitive attributes**: we DON'T attach customer phone or invoice id to spans. Span attributes are tenant_id (uuid) and branch_id (uuid) only — PDPL-safe. Auditors who want "show me every span for tenant X" can filter on `matgary.tenant_id`.
3. **Cardinality budget**: `payment_method` is one of {cash, instapay, card, deferred, initial}. `cart.line_count` is an integer up to ~20. Both safe for span attributes.
4. **Local opt-in only**: nothing changes for engineers who don't set `OTEL_SERVICE_NAME`. The no-op tracer is the default.
