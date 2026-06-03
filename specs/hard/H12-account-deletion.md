# H12 — Real account deletion + 30-day grace

> Source: `task.md` §7.1 H12

- **Status:** pending
- **Effort estimate:** 4-5 hrs
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

(populated during execution)
