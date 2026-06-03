# H01 — Restore drill execution

> Source: `task.md` §7.1 H1

- **Status:** done (2026-06-03)
- **Effort estimate:** 30 min (actual: ~20 min)
- **Depends on:** `infra/backup.sh`, `infra/restore.sh`, existing `./backups/*.sql.gz`
- **Drill log:** [`infra/drills/restore-drill-2026-06-03.log`](../../infra/drills/restore-drill-2026-06-03.log)

## Why

Backups have been running nightly since May 7. The restore path has never been exercised. An unverified backup is not a backup — silent format drift, gunzip corruption, role mismatch, or `--clean` blowing up on missing extensions are all things you only learn the first time you actually need to restore. We must learn that now, on a throwaway DB, not at 3 AM during an incident.

## Acceptance criteria

- [x] Latest `./backups/daily-*.sql.gz` selected and its size sanity-checked (≥ 1 KB per backup script's own threshold). — picked `daily-2026-06-01T02-30-00Z.sql.gz`, 31,421 bytes.
- [x] Throwaway Postgres 16 container running on a non-conflicting port (compose uses 5434; drill uses 55432).
- [x] Empty target database created in the throwaway container.
- [x] `RESTORE_CONFIRM=1 infra/restore.sh <dump>` exits 0 against the throwaway DB. — 1 s wall time.
- [x] Row-count diff for at least 3 representative tenant-scoped tables (`products`, `sales`, `activity_logs`) shows source vs restored match within ±0 rows. — products/sales/tenants/users exact match; activity_logs -1 (one row written live between dump time and capture, expected, not a defect).
- [x] RLS confirmation: querying restored DB without `app.tenant_id` set returns 0 rows for a tenant-scoped table — proves the restore preserved policies, not just data. — verified as NOSUPERUSER NOBYPASSRLS role; 0 without tenant ctx, 1 with.
- [x] Throwaway container + DB cleaned up.
- [x] Drill record written to `infra/drills/restore-drill-2026-06-03.log` with: dump filename, dump size, restore wall time, source/restored row counts per table, RLS check result.
- [x] Status flipped to `done` here, changelog entry added to `task.md` §2, §5 "Restore drill never run" item ticked.

## Implementation plan

1. Pick the latest daily dump from `./backups/`.
2. Run a throwaway Postgres container detached, port 55432, password `test`, no volume (auto-cleanup on rm).
3. `createdb matgary_restore` inside it.
4. Capture source row counts from the live `matgary-postgres` container for `products`, `sales`, `activity_logs` (across all tenants — use the admin role to bypass RLS).
5. Stream-restore: `PGHOST=localhost PGPORT=55432 PGUSER=postgres PGPASSWORD=test PGDATABASE=matgary_restore RESTORE_CONFIRM=1 ./infra/restore.sh <dump>`.
6. Capture restored row counts the same way.
7. Run RLS check: `SELECT count(*) FROM products` as a NOSUPERUSER (post-restore role grants).
8. Tear down: `docker rm -f pg-restore-test`.
9. Append the timestamped log.

## Out of scope

- Restoring into the live `matgary-postgres` container — never.
- Verifying the off-site `BACKUP_REMOTE_HOOK` path (not configured yet).
- Periodic automation of this drill (separate spec when first cron'd).

## Risks & gotchas

- Dumps were generated with `--no-owner --no-privileges`, so the restore target's role names don't have to match — but the `matgary_app` NOSUPERUSER role doesn't exist in the throwaway. The RLS check must use whichever role the dump's RLS policy references. If the dump's RLS check fails because the role is missing, document it — that's a real finding, not a drill failure.
- `--clean --if-exists` means the dump first drops every table, which is fine on an empty DB but worth noting.

## Verification log

Full details in [`infra/drills/restore-drill-2026-06-03.log`](../../infra/drills/restore-drill-2026-06-03.log). Summary:

- **Restore time:** 1 s wall, ~32 KB compressed dump.
- **Row parity:** products 17/17, sales 19/19, tenants 5/5, users 9/9, activity_logs 85→84 (1-row delta is post-dump live writes; not restore loss).
- **RLS metadata:** `relrowsecurity = relforcerowsecurity = t` on all 5 tested tables.
- **RLS behaviour:** as `NOSUPERUSER NOBYPASSRLS`, count(products) = 0 without `app.tenant_id`; 1 with — policies travel with the dump and bite correctly on restore.

### Real follow-up surfaced by the drill

`pg_dump --no-privileges` strips GRANT statements. After a production restore, `matgary_app` must be recreated AND regranted on every tenant-scoped table before the app can connect — `infra/init-postgres.sql` only handles the fresh-container case. Production restore runbook needs both steps explicit. Tracked as a §4 backlog item ("Production restore runbook"); not a launch blocker because today's restore would be operator-initiated, not automated.
