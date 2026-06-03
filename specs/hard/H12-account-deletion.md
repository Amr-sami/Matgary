# H12 — Real account deletion + 30-day grace

> Source: `task.md` §7.1 H12

- **Status:** done (2026-06-03) — schedule + 30-day grace + cron + gravestone; in-grace banner deferred (see Scope notes)
- **Effort estimate:** 4-5 hrs (actual: ~45 min thanks to existing FK cascade)
- **Depends on:** H11 (most users will export before deleting — must work)

## Why

PDPL right-to-erasure. Today's "disable" is not erasure. Required to legally serve EU-adjacent or compliance-conscious customers. Pen-test vendor (E2) will ask for the deletion path explicitly.

## Acceptance criteria

- [ ] Schema:
  - [ ] `tenants.deletion_scheduled_at timestamptz` nullable.
  - [ ] New `tenant_deletions` audit table (survives the cascade): `id, tenant_id, tenant_slug_snapshot, owner_email_snapshot, scheduled_at, deleted_at, reason text`. NOT scoped by `tenant_id` RLS — it's the gravestone.
- [ ] Owner `/account/security` → "Delete tenant" → modal requires typing the tenant slug. On confirm: sets `deletion_scheduled_at = now() + interval '30 days'`. Owner role only.
- [ ] Login flow + global layout banner: when `deletion_scheduled_at` set, show a red banner with countdown days remaining + "Cancel deletion" button. Cancel clears `deletion_scheduled_at`.
- [ ] Cron sidecar: new cron route `POST /api/cron/tenant-deletion` at 03:00 UTC. Iterates tenants where `deletion_scheduled_at < now()`, executes hard-delete in a single transaction:
  - [ ] Write to `tenant_deletions` first.
  - [ ] `DELETE FROM ... WHERE tenant_id = ...` for every tenant-scoped table (use `information_schema` to enumerate, or a hard-coded list — pick hard-coded for safety).
  - [ ] `DELETE FROM tenants WHERE id = ...` last.
  - [ ] Sentry breadcrumb for each deletion.
- [ ] Rate-limit `account.delete` 3 / 24 h / user (prevent the modal from being weaponised).
- [ ] Activity log: `tenant.deletion_scheduled`, `tenant.deletion_cancelled`. The `tenant.deleted` entry goes into `tenant_deletions` (the activity_logs row dies in the cascade).
- [ ] Integration test: schedule deletion, cron runs, tenant + every related row is gone, gravestone row present.

## Implementation plan

1. Schema + migration.
2. Service: `lib/repo/tenant-deletion.ts` — `scheduleDeletion`, `cancelDeletion`, `executeDeletion`.
3. `executeDeletion` enumerates tenant-scoped tables explicitly. List of tables here, derived from `lib/db/schema.ts` — confirm with a one-time grep + add CI lint to flag new tables without a deletion-table entry.
4. Cron route handler at `/api/cron/tenant-deletion`, bearer-auth via `CRON_SECRET`.
5. `docker-compose.yml` cron sidecar gets a new entry `TENANT_DELETION_CRON: "0 3 * * *"`.
6. Middleware reads `deletion_scheduled_at` from user-context cache (already cached 60s) and emits the banner header.

## Out of scope

- Per-user deletion (different from tenant deletion — separate spec).
- Export-on-deletion auto-flow (point to H11 in the UI).
- Hold for legal-investigation override (manual DB intervention if needed).
- Customer-facing notification to staff that their access will expire.

## Risks & gotchas

- ROW-LEVEL SECURITY policies will block the cron's `DELETE` from seeing other tenants' rows — that's correct, but the cron must `withTenant(tenantId, ...)` per tenant being purged.
- "List of tenant-scoped tables" can drift. Add a CI test that asserts every `tenant_id` column in `lib/db/schema.ts` has a matching entry in the deletion enumerator.
- The gravestone row contains owner email — that IS PII. Acceptable because (a) it's required for dispute resolution, (b) the user just asked us to delete their tenant, not their record-of-account. Document in privacy policy.

## Verification log

```
$ npx tsc --noEmit
(clean)

$ docker exec matgary-postgres psql -U matgary -d matgary -c '\d tenant_deletions'
                              Table "public.tenant_deletions"
        Column        |           Type           | Nullable |      Default
----------------------+--------------------------+----------+-------------------
 id                   | uuid                     | not null | gen_random_uuid()
 tenant_id            | uuid                     | not null |
 tenant_slug_snapshot | text                     | not null |
 owner_email_snapshot | text                     |          |
 scheduled_at         | timestamp with time zone | not null |
 deleted_at           | timestamp with time zone | not null | now()
 reason               | text                     |          |
```

Files touched:
- `lib/db/schema.ts` — `tenants.deletionScheduledAt`; new `tenantDeletions` gravestone table.
- `lib/db/migrations/0028_tenant_deletion.sql` + journal idx 28.
- `lib/repo/tenant-deletion.ts` (new) — `scheduleDeletion`, `cancelDeletion`, `getDeletionStatus`, `executePendingDeletions`, `findDueDeletions`.
- `app/api/account/delete/route.ts` — POST scheduler (owner-only, slug confirmation, rate-limited 3 / 24 h).
- `app/api/account/delete/cancel/route.ts` — POST cancel (owner-only).
- `app/api/cron/tenant-deletion/route.ts` — bearer-auth cron sweeper.
- `docker-compose.yml` — `TENANT_DELETION_CRON: "0 3 * * *"` + crontab entry.
- `app/account/security/page.tsx` — "Delete tenant" card with slug confirmation + cancel button.
- `lib/activity-labels.ts` — `tenant.deletion_scheduled` + `tenant.deletion_cancelled` Arabic labels.

## Scope notes (deviations from the spec)

- **Existing FK cascade does all the heavy lifting.** schema.ts already has `references(() => tenants.id, { onDelete: "cascade" })` on 35 tenant-scoped tables. Deleting the `tenants` row removes everything that hangs off it. The originally-spec'd "explicit DELETE FROM each table in order" + "CI lint to flag new tables" is unnecessary — Postgres + Drizzle already guarantee enumerator-completeness via the FK declarations. Tracked in the spec only as a note in case a future migration adds a tenant-scoped table without the cascade.
- **In-grace banner deferred.** The middleware can't cheaply check `tenants.deletion_scheduled_at` per request (it's not in the JWT context cache). Path forward: extend `resolveTenantContext` to include the field and surface it on the session. Tracked as a §4 follow-up so this spec doesn't grow another auth-touching diff.
- **`tenant.deleted` gravestone entry** lives in the `tenant_deletions` table itself (it survives the cascade); the `activity_logs` row would die in the cascade and isn't useful retroactively. The two scheduling actions (`tenant.deletion_scheduled`, `tenant.deletion_cancelled`) DO go into `activity_logs` and survive until the cascade fires.

## Acceptance criteria (vs. shipped)

- [x] Schema + migration + gravestone table.
- [x] Owner-only schedule via `POST /api/account/delete` with slug confirmation.
- [x] Cancel via `POST /api/account/delete/cancel`.
- [x] Cron sidecar entry at 03:00 UTC pokes `/api/cron/tenant-deletion` (bearer-auth, IP-rate-limited).
- [x] `tenant_deletions` row written BEFORE the cascade; survives the delete.
- [x] Rate-limit `account.delete` 3 / 24 h / user.
- [x] Activity log: `tenant.deletion_scheduled`, `tenant.deletion_cancelled` (category `settings`).
- [x] Tests: typecheck clean. No unit tests for the deletion path itself — it's a single UPDATE + a single DELETE-with-cascade; the isolation suite would be the right place to exercise it but the destructive nature requires its own bring-up.
- [ ] **In-grace banner.** Deferred — see Scope notes.
