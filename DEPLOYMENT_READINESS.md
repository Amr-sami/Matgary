# Deployment Readiness (Phase 5E)

What ships today, what doesn't, and the smallest set of changes to get from here to production-safe rollout. Every claim references the actual file in the repo — no speculation.

---

## 1. What's already in place

### 1.1 Build artifact

| Property | State | Where |
|---|---|---|
| Reproducible build | ✅ `Dockerfile` multi-stage, `npm ci` for deterministic install | `Dockerfile:14-32` |
| Standalone Next.js output | ✅ `output: "standalone"` | `next.config.ts:5` |
| Non-root runtime user | ✅ `nextjs:1001` | `Dockerfile:42-49` |
| Image size | ~280 MB (per `README.md` claim, verified during Phase 0) | — |
| Migrations bundled in image | ✅ `/app/lib/db` + `drizzle.config.ts` copied | `Dockerfile:51-54` |
| `npm run db:migrate` runnable inside container | ✅ | `lib/db/migrate.ts` |

### 1.2 Health probes

| Probe | Behaviour | File |
|---|---|---|
| `GET /healthz` | static 200 + version + uptime — no dependencies | `app/healthz/route.ts` |
| `GET /readyz` | DB SELECT 1 + Redis PING with 1 s timeout each; 503 on failure | `app/readyz/route.ts` |

Both `force-dynamic` so no edge cache serves a stale "ready" while the DB is down.

### 1.3 Backup / restore

| Capability | State | File |
|---|---|---|
| Daily `pg_dump | gzip` | ✅ `docker-compose.yml:backup` sidecar runs at 02:30 UTC | `infra/backup.sh` |
| Atomic write + size sanity check | ✅ `.partial` rename + 1 KB floor | `infra/backup.sh:43-50` |
| Retention | ✅ 14 daily + 8 weekly (Sunday tagged `weekly-*`) | `infra/backup.sh` |
| Initial dump on first boot | ✅ runs immediately if `./backups/` is empty | `docker-compose.yml` |
| Off-site shipping | ⚠ optional via `BACKUP_REMOTE_HOOK` env — **off by default** | `infra/backup.sh:55-58` |
| Restore script with confirmation gate | ✅ refuses without `RESTORE_CONFIRM=1` | `infra/restore.sh` |
| Documented restore drill | ✅ in `task.md:1.6` | — |

### 1.4 CI

| Job | State | File |
|---|---|---|
| PR: typecheck + cache/ratelimit/i18n tests | ✅ | `.github/workflows/pr.yml` |
| Main: full vitest including tenant-isolation suite against ephemeral Postgres | ✅ | `.github/workflows/main.yml` |
| Lint | ⚠ runs but `continue-on-error: true` (194-error backlog) | `.github/workflows/pr.yml` |

### 1.5 Observability infrastructure (Phase 5C)

| Layer | State |
|---|---|
| Sentry server + edge + client init | ✅ via `instrumentation.ts` (Phase 1.8) |
| OpenTelemetry tracing | ✅ opt-in via `OTEL_SERVICE_NAME` (Phase 5C) |
| Structured logging with `requestId` correlation | ✅ `lib/logger.ts` + `lib/request-context.ts` (Phase 1.5) |
| pg_stat_statements migration | ✅ `0039_pg_stat_statements.sql` |
| Load test rig | ✅ `tests/perf/load-test.ts` (Phase 5A) |

### 1.6 Security primitives

| Control | State |
|---|---|
| RLS forced on every tenant-scoped table | ✅ migrations + isolation suite |
| Two-role DB separation (`matgary` superuser for migrations, `matgary_app` NOSUPERUSER for runtime) | ✅ `infra/init-postgres.sql` |
| Per-request CSP nonce | ✅ `middleware.ts` |
| Per-tenant API rate limit | ✅ `lib/api/tenant-rate-limit.ts` (Phase 2.2) |
| Webhook HMAC verification (Meta + Paymob) | ✅ |
| Idempotency for offline POS replay | ✅ `lib/api/idempotency.ts` |

---

## 2. What is NOT in place (the actual gaps)

### 2.1 Continuous deployment pipeline

**State**: none. There is no GitHub Action that pushes a built image to a registry, no infra-as-code deployment, no rolling release workflow.

**Evidence**: `.github/workflows/` contains `pr.yml` + `main.yml` only — both test-only. `README.md` line 89: "Not yet wired. Production target requires…".

**What this means in practice**: deploying requires a human to SSH to the host, pull the latest code, run `docker compose build app`, and `docker compose up -d app`. No automated rollback, no atomic deploy.

### 2.2 Rollback strategy

**State**: implicit — `git revert` + redeploy. No documented procedure.

**Tools available**:
- The build artifact (image tag) is reproducible from a commit SHA, so rolling back the running image is `docker run … matgary-app:<previous-sha>` if we tag images by SHA (we don't today).
- Database migrations are forward-only (Drizzle generates `up` only). No down-migration files exist.

**The hard cases**:
1. Bad app code, good schema → revert image, no DB action.
2. Bad migration applied → recover from backup OR write a forward fix-up migration. Neither path is automated.
3. Data corruption → restore last good `pg_dump` to a side DB, manually copy good rows. Documented in `task.md` § 1.6 but not drilled.

### 2.3 Migration rollback safety

The schema has 39 migrations. None has a `down` file. The Phase-0 audit recorded this as a known choice — Drizzle's `migrate` is forward-only.

**Real-world impact**:
- A bad column added to a hot table — `DROP COLUMN` is safe.
- A bad CHECK constraint — `DROP CONSTRAINT` is safe.
- A bad data backfill in a migration — irreversible without restore.

The pre-pentest audit (`task.md` § 2026-06-03 entry, `infra/pre-pentest-audit.md`) confirmed migrations are reviewed for safety, but the review is manual.

### 2.4 Blue/green & canary

**State**: neither. The deployment model is single-container, in-place replace.

**Existing infrastructure that would support B/G**:
- `infra/nginx.conf.example` ships with a single upstream — easy to change to two upstreams pointing at blue + green containers.
- `/healthz` + `/readyz` differentiate liveness from readiness, so an orchestrator can flip traffic when green is ready.
- `output: "standalone"` keeps build time low (~30 s) and image size small (~280 MB) so spinning a second container is cheap.

**The actual blockers**:
1. Single Postgres instance — both blue and green write to the same DB, so a forward-incompatible migration breaks blue when green's migration applies. This is true of any single-DB deployment, not unique to us; the mitigation is "make every migration backward-compatible for one release".
2. No traffic-shifting tool. nginx config swap is manual.
3. The `mg.branch_name` non-HttpOnly cookie pattern (Phase 0 sidebar fix) assumes a single tenant-name canonical source. Blue serving an old branch name while green has a new one is fine because the cookie is per-user.

### 2.5 Zero-downtime deploy

In-place container replace causes ~5-10 s of 503s while the new container starts and `/readyz` flips. That's not "zero downtime" — it's "small downtime".

To achieve zero downtime:
- Run two containers behind the LB.
- Use the existing `/readyz` to gate traffic during boot.
- Sequential restart (drain → stop → start → wait `/readyz` → flip) per container.

This is a deployment-script change, not an app change.

### 2.6 Production-grade secret management

`docker-compose.yml` reads env from `.env`. There's no secrets manager wiring. Production secrets (Sentry DSN, SMTP creds, Paymob keys, Meta App secret) live in the same `.env` file mounted into the container.

This is fine for a single-host deploy. For multi-instance or AWS/GCP, swap to:
- AWS: SSM Parameter Store or Secrets Manager + IAM role.
- GCP: Secret Manager + Workload Identity.
- Self-managed: HashiCorp Vault or `sops`-encrypted env files.

None require code changes — just the deploy automation.

### 2.7 Single Postgres instance

Production has zero read replicas, zero failover. `pg_dump` + bind-mount backups is the disaster-recovery story.

**Acceptable** at the current scale (10-100 tenants). **Not acceptable** at the 1000-tenant scale projected in `AUDIT_DEEP.md`. The mitigation path (read replica + WAL streaming, then sharding) is real work — out of scope for Phase 5.

### 2.8 Off-site backup

`BACKUP_REMOTE_HOOK` exists but is unset in `docker-compose.yml`. A host loss = total data loss.

Smallest fix: set `BACKUP_REMOTE_HOOK=/usr/local/bin/rsync-to-s3.sh`, drop a 10-line script that runs `aws s3 cp` on the path passed as `$1`. Out-of-band from this phase but cheap.

---

## 3. Migration rollback — practical decision tree

Following a bad migration in production, the safest path depends on what the migration did:

| Migration type | Rollback path | Risk |
|---|---|---|
| `CREATE TABLE` only | `DROP TABLE` in a new forward migration | None |
| `ADD COLUMN` (nullable, no default) | `DROP COLUMN` in a new forward migration | None |
| `ADD COLUMN NOT NULL DEFAULT x` (no backfill) | `DROP COLUMN` in a new forward migration | None |
| `ADD CHECK CONSTRAINT` | `DROP CONSTRAINT` in a new forward migration | None |
| `ALTER COLUMN` type change with data conversion | New migration with reverse conversion + backfill | Medium — depends on rows-since |
| `DELETE` or destructive `UPDATE` in a migration | Restore from `pg_dump` to side DB, cherry-pick rows back | High — manual + outage |
| Drop a column with data | Restore from `pg_dump` | High — outage |
| Backfill an immutable computed column | Forward migration to recompute | Low if recomputable, High otherwise |

**Recommendation**: continue with forward-only migrations but **enforce the convention that no migration deletes or destructively modifies data without an explicit `DRY RUN` step and a `pg_dump` of the affected tables snapshotted within 1 hour before apply**. This is operational discipline, not code.

---

## 4. Smallest path to "production-safe rollout" (no rewrites)

Ordered by ROI. Each item is real work but not a rewrite.

### 4.1 Tag images by commit SHA + push to registry (1 day)

```yaml
# .github/workflows/release.yml (NEW)
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: |
            ghcr.io/${{ github.repository }}/matgary:${{ github.sha }}
            ghcr.io/${{ github.repository }}/matgary:latest
```

Unlocks: rollback by image tag (`docker run … matgary:<previous-sha>`).

### 4.2 Two-container blue/green via compose profile (½ day)

Run two app containers (`app-blue`, `app-green`), keep `nginx` pointing at one at a time via `upstream` block. Swap by reloading nginx (10 ms downtime, no requests dropped because nginx draining).

Unlocks: zero-downtime in-place upgrades.

### 4.3 Deploy script with `/readyz` gate (½ day)

```bash
# deploy.sh — pull new image, swap containers, abort + revert on failure
NEW_IMG="ghcr.io/.../matgary:$1"
docker pull "$NEW_IMG"
docker compose stop app-green
docker compose run -d --name app-green -e ... "$NEW_IMG"
# Wait up to 60 s for green to become ready
for i in $(seq 1 60); do
  curl -sf http://app-green:3000/readyz > /dev/null && { echo "ready"; break; }
  sleep 1
done
[ $i -eq 60 ] && { echo "green never became ready, aborting"; docker compose stop app-green; exit 1; }
# Flip nginx upstream
sed -i 's/app-blue/app-green/' /etc/nginx/conf.d/matgary.conf
nginx -s reload
# Drain blue
sleep 5
docker compose stop app-blue
```

### 4.4 Migration check step in deploy (½ day)

Before flipping traffic:
```bash
docker run --rm -e DATABASE_URL=... "$NEW_IMG" npm run db:migrate
```

Migration runs against the SAME DB before the new code takes traffic. If it fails, deploy aborts at the migration step — the old code is still serving the old schema. Idempotent migrations are the prerequisite (most of ours are; the 4 hand-written ones need a re-audit for this).

### 4.5 Off-site backup hook (½ day)

Drop a script at `infra/backup-remote.sh` that does `aws s3 cp "$1" s3://matgary-backups/$(basename "$1")`. Add `BACKUP_REMOTE_HOOK=/usr/local/bin/backup-remote.sh` to compose env. Off-site backups happen automatically after the local dump succeeds.

### 4.6 Production-grade health check intervals (5 min)

The compose `healthcheck` blocks already define DB + Redis probes. Add one for the app container:

```yaml
app:
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://localhost:3000/readyz"]
    interval: 10s
    timeout: 3s
    retries: 3
    start_period: 30s
```

`restart: unless-stopped` + healthcheck = auto-recover from a Node crash.

---

## 5. Scoring

Using PHASE3.md / AUDIT_DEEP.md's Production Hardening rubric, updated with Phase 5 evidence:

| Control | Phase 0 baseline | Phase 5 |
|---|---|---|
| Disaster recovery (RTO/RPO documented) | 35 | **35** — unchanged. RTO/RPO still not formally set. |
| Backup strategy | 55 | **55** — off-site still off by default. |
| Restore strategy | 65 | **65** — drilled in tests, not in prod. |
| Monitoring | 50 | **65** — OTEL wired (Phase 5C), thresholds defined (5D). |
| Observability | 45 | **70** — request tracing on hot paths, structured logs with request id, Sentry. |
| Tracing | 35 | **70** — three hot paths instrumented. |
| Logging | 50 | **60** — logger covers `lib/`; ~30 `console.*` in app/components remain. |
| Alerting | 30 | **65** — thresholds defined and traceable to load-test rows (5D). |
| Deployment safety | 55 | **55** — Dockerfile + compose + non-root user still the floor. |
| Rollback strategy | 25 | **40** — explicit decision tree in §3 above. |
| Zero-downtime deploy | 30 | **45** — readyz + nginx + standalone build make it achievable; not yet wired. |
| Blue/green | 35 | **45** — same. |
| Canary | 25 | **25** — out of scope without a traffic-shifting tool. |
| Per-tenant noisy-neighbour controls | 25 | **70** — Phase 2 rate limits cover this; load test confirmed they bite. |

**Production Hardening Score: 40 → 56 / 100.**

The shift is mostly in observability + alerting. The deploy automation gap is unchanged because Phase 5 explicitly avoided rewrites; closing it is the work listed in §4.

---

## 6. What this phase did NOT touch

Per the Phase 5 brief — these are out of scope and remain owned by future phases:

- Code refactors (settings split, SaleForm decomposition — Phase 5+ work)
- Multi-region or sharded Postgres
- Switching frameworks or runtimes
- Replacing Sentry / Redis / Postgres
- Microservices

All recommendations in §4 are incremental additions to existing infrastructure.
