# H11 — PDPL data-export endpoint

> Source: `task.md` §7.1 H11

- **Status:** pending
- **Effort estimate:** 3-4 hrs
- **Depends on:** none (but H07 will audit the link-signing approach)

## Why

Egyptian Law 151/2020 right-of-access. The privacy policy already promises an export — we must deliver. Today it does not exist.

## Acceptance criteria

- [ ] `POST /api/account/export` — enqueues a job (BullMQ already in deps), returns 202 with `{ jobId }`. Owner role only.
- [ ] Background worker assembles a zip in-memory and uploads/emails it.
- [ ] Zip contents (one JSON file per resource, tenant-scoped via `withTenant`):
  - [ ] `products.json`
  - [ ] `sales.json` (with line items + payment method + customer snapshot)
  - [ ] `returns.json`
  - [ ] `expenses.json`
  - [ ] `suppliers.json`
  - [ ] `purchase_orders.json`
  - [ ] `customers.json` (derived from sales)
  - [ ] `attendance.json`
  - [ ] `payroll.json`
  - [ ] `leave_requests.json`
  - [ ] `activity_log.json`
  - [ ] `manifest.json` (export date, schema versions, tenant slug)
- [ ] Email to owner with a signed download link, 15 min TTL, single-use.
- [ ] Download route validates signature, marks token consumed in Redis, streams the zip from disk, deletes the file after the response (or on TTL expiry, whichever first).
- [ ] Rate-limit `account.export` 2 / 24 h / user.
- [ ] Activity log: `account.data_export_requested`, `account.data_export_downloaded`.
- [ ] Test: signed link with mutated payload is rejected.

## Implementation plan

1. New BullMQ queue `data-export`. Job payload: `{ userId, tenantId }`.
2. Worker: per-table reads → write JSON files to a tmp dir → `archiver` to zip → store under `/tmp/exports/<job-id>.zip` (mounted; cleanup cron sweeps anything older than 1 h).
3. Signed link: `HMAC(SECRET_KEY, "${jobId}.${expiresAt}")` → `/api/account/export/download?j=<id>&e=<ts>&s=<sig>`.
4. Download route: constant-time HMAC compare; check `e` > now; check Redis `export:consumed:<jobId>` not set; mark consumed; stream; on `res.end`, unlink.
5. Email via existing `lib/mailer.ts`.

## Out of scope

- Per-resource granular export ("just my activity log").
- Auto-recurring exports.
- Encrypted-at-rest zip (consider for E2 follow-up).
- Cross-tenant export for multi-tenant owners.

## Risks & gotchas

- The activity log can be large for older tenants. Worker should stream-write JSON (one row at a time) not buffer in memory.
- Download link in email gets forwarded — signed + single-use + short TTL together make this acceptable. Audit doc (H07) re-reviews.
- Customers "table" is derived; document the derivation rule in `manifest.json` so the export remains interpretable in 2 years.

## Verification log

(populated during execution)
