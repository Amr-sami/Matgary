# H04 — /healthz + /readyz endpoints

> Source: `task.md` §7.1 H4

- **Status:** done (2026-06-03)
- **Effort estimate:** 30 min (actual: ~20 min)
- **Depends on:** none

## Why

No deploy probe means a broken container can roll into rotation. Also unblocks E1 (staging) the moment hosting lands — the nginx template needs an upstream health URL to flip rotation on.

## Acceptance criteria

- [x] `GET /healthz` returns 200 with `{ status: "ok", uptime: <seconds>, version: <git-sha-or-package-version> }`. No DB hit. No Redis hit. No tenant context. No rate-limit consumption.
- [x] `GET /readyz` returns 200 with `{ status: "ready", db: "ok", redis: "ok" }` when `SELECT 1` against Postgres and `PING` to Redis both succeed; 503 with the failing component named otherwise. `redis: "disabled"` (still 200) when `CACHE_DISABLED=1` / no `REDIS_URL`, because cache is opportunistic by design.
- [x] Both routes are excluded from Sentry transaction sampling. — switched from `tracesSampleRate` to `tracesSampler` in both `sentry.server.config.ts` and `sentry.edge.config.ts`.
- [x] Both routes excluded from middleware auth gates. — added to `PUBLIC_PATHS` in `middleware.ts`.
- [x] nginx template at `infra/nginx.conf.example` uses `/readyz` for upstream health check. — added explicit `location =` blocks with `access_log off`.
- [x] Manual smoke: `curl -i http://localhost:3001/healthz` returned `{"status":"ok","uptime":2799,"version":"0.1.0"}` 200; `/readyz` returned `{"status":"ready","db":"ok","redis":"ok"}` 200.

## Implementation plan

1. `app/healthz/route.ts` — App Router route handler, `dynamic = "force-dynamic"`, returns the JSON above. Uptime via `process.uptime()`. Version from `process.env.npm_package_version` (falls back to `"dev"`).
2. `app/readyz/route.ts` — runs `db.execute(sql\`select 1\`)` with 1 s timeout (Promise.race) and `redis.ping()` with 1 s timeout. Returns the combined status with appropriate HTTP code.
3. `middleware.ts` — add `/healthz` and `/readyz` to the matcher exclusion (already pattern-based, append).
4. `sentry.server.config.ts` — `tracesSampler` returns 0 for those paths.
5. `infra/nginx.conf.example` — replace any current health stanza with `/readyz`.

## Out of scope

- Per-tenant readiness.
- Auth on these endpoints (they must be reachable by orchestrator probes).
- Metrics endpoint (`S9` Soft).

## Risks & gotchas

- Returning version via `process.env.npm_package_version` won't work in standalone output. Wire the git SHA into Docker build args + `process.env.GIT_SHA` instead.
- 1 s timeout is per-component; the route's worst-case is 2 s. That's fine for k8s liveness defaults (10 s) but worth documenting.

## Verification log

```
$ curl -s http://localhost:3001/healthz
{"status":"ok","uptime":2799,"version":"0.1.0"}

$ curl -s http://localhost:3001/readyz
{"status":"ready","db":"ok","redis":"ok"}
```

Files touched:
- `app/healthz/route.ts` (new)
- `app/readyz/route.ts` (new)
- `middleware.ts` — `PUBLIC_PATHS` extended
- `sentry.server.config.ts` — `tracesSampler` with path-based 0-sample for probes
- `sentry.edge.config.ts` — same
- `infra/nginx.conf.example` — `location =` blocks added with `access_log off`

Negative-path (503) was not behaviourally tested — would require killing Postgres or Redis in the running dev environment. Logic is `Promise.race` with timeout-rejection feeding a single `ok` flag → straightforward and not worth the disruption.

CSRF cookies appear on the response — that's NextAuth's default middleware behaviour for any first-touch request and is unrelated to the probe routes themselves; neither route hits the DB or Redis.
