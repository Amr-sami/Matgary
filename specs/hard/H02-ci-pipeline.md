# H02 — CI pipeline (GitHub Actions)

> Source: `task.md` §7.1 H2

- **Status:** done (2026-06-03)
- **Effort estimate:** 1-2 hrs (actual: ~30 min)
- **Depends on:** none

## Why

Manual `npx tsc --noEmit` before push is not a safety net. A money-handling SaaS needs automated gates that run on every change — type errors, lint regressions, and the tenant-isolation tests must fail loudly in PR before they reach `main`.

## Acceptance criteria

- [x] `.github/workflows/pr.yml` runs on every PR: `npm ci` → `npx tsc --noEmit` → lint → Redis-gated vitest (`cache.test.ts` + `ratelimit.test.ts`).
- [x] `.github/workflows/main.yml` runs on push to `main`: above + Postgres service + role provisioning + migrations + full `npx vitest run`.
- [x] Both workflows cache `~/.npm` via `actions/setup-node@v4` `cache: npm`.
- [x] Postgres service in `main.yml` provisions `matgary` (via `POSTGRES_USER` env) and `matgary_app` NOSUPERUSER NOBYPASSRLS (via `psql -f infra/init-postgres.sql`) before migrations.
- [x] `DATABASE_URL` ends in `_test` so the isolation suite's safety regex (`/(?:^|[/_\-])test(?:[/_\-]|$)/i`) matches; `TEST_DB_WIPE=1` set in workflow env.
- [x] README "Tests" section updated to point at CI as the source of truth.
- [ ] **Manual:** branch protection on `main` requires PR workflow green. — flagged in README + task.md; one-click in repo settings, can't be done from code.
- [ ] **Verified on a real PR.** — workflows pass YAML parse + local typecheck; full green-check verification requires a push.

## Known trade-off

- Pre-existing lint state: 194 errors + 970 warnings in the codebase, none from the new code (specs, healthz/readyz routes, ratelimit test). Lint step is `continue-on-error: true` so it surfaces signal without gating PRs. Tracked as a §4 backlog item "Cleanup pre-existing lint errors". Removing the `continue-on-error` line is the closing step once the backlog is empty.

## Implementation plan

1. `pr.yml`:
   - `node-version: 20`, `cache: npm`.
   - Redis 7 service on port 6379, `REDIS_URL=redis://localhost:6379`.
   - Steps: checkout, setup-node, `npm ci`, `npx tsc --noEmit`, `npm run lint`, `npx vitest run tests/cache.test.ts`.
2. `main.yml`:
   - Same as above plus Postgres 16 service.
   - One extra step before tests: `psql` against the service to create `matgary_app` with `NOSUPERUSER NOBYPASSRLS` and grant table privileges (mirror `infra/init-postgres.sql`).
   - Env: `TEST_DB_WIPE=1`, `DATABASE_URL=postgres://matgary:matgary@localhost:5432/matgary_test`, `APP_DATABASE_URL=postgres://matgary_app:matgary_app@localhost:5432/matgary_test`.
   - Run migrations: `npm run db:migrate`.
   - Test: `npx vitest run`.

## Out of scope

- E2E smoke test (H05 — added to `main.yml` once it exists).
- Auto-deploy on green (E1 staging — gated on hosting decision).
- Required-status checks for `lint` separately from `pr` (one combined workflow is fine for v1).

## Risks & gotchas

- The isolation suite hard-gates on `DATABASE_URL` containing the substring `test` — the CI DB name must include it (`matgary_test` chosen above).
- `init-postgres.sql` runs on a fresh container via the docker-entrypoint init dir. In CI we don't get that path on a service container — must run the role-creation SQL explicitly before tests.

## Verification log

```
$ npx tsc --noEmit
(no output — clean)

$ python3 -c "import yaml; yaml.safe_load(open('.github/workflows/pr.yml')); yaml.safe_load(open('.github/workflows/main.yml')); print('OK')"
OK

$ npm run lint 2>&1 | tail -3
✖ 1164 problems (194 errors, 970 warnings)
  1 error and 14 warnings potentially fixable with the `--fix` option.
```

194 errors are pre-existing; none in the spec-driven additions. Workflow lint step is non-blocking (`continue-on-error: true`) until the §4 backlog clears.

Files touched:
- `.github/workflows/pr.yml` (new)
- `.github/workflows/main.yml` (new)
- `README.md` — Tests section points at CI as source of truth.
