# Platform Admin — Spec 08: Audit log viewer

Owner: Amr · Drafted: 2026-06-10 · Depends on: **Spec 01** (and is most
useful after Specs 03 / 05 / 07 have written real rows).

The read-side counterpart to the audit logging that every earlier spec
has been writing. By the time this spec ships, `admin_audit_log` has a
few hundred rows — this page lets us filter and inspect them.

[master]: ./platform-admin-dashboard.md

---

## 1. Goal

Logged-in admin can:

- Open `/admin/audit` and see the last 100 admin actions chronologically.
- Filter by:
  - actor (admin email select)
  - action prefix (`tenant.*`, `plan.*`, `impersonate.*`, …)
  - target kind / target id
  - free-text on JSON diff (`q` matches `before_jsonb ‖ after_jsonb` text)
  - date range
- Click a row → modal with the full before/after JSON diff rendered
  as a side-by-side or unified diff.
- Page through older entries (cursor-based on `occurred_at`).

`ops_admin` sees this page too (audit visibility is a Good Thing for
the people supporting customers).

---

## 2. Data — no new migrations

`admin_audit_log` already exists from Spec 01. We add a small index
helper to keep the free-text query reasonable:

Already created in Spec 01:
- `admin_audit_admin_time_idx (admin_id, occurred_at DESC)`
- `admin_audit_target_idx (target_kind, target_id)`

For free-text on diff jsonb we'll add this index inside this spec
(small migration `0036_admin_audit_search.sql`):

```sql
-- GIN over the union of before+after; gives us LIKE-able lookups.
CREATE INDEX IF NOT EXISTS admin_audit_diff_gin_idx
  ON admin_audit_log
  USING GIN ((coalesce(before_jsonb::text, '') || ' ' || coalesce(after_jsonb::text, '')) gin_trgm_ops);

-- pg_trgm must be enabled (likely already is; idempotent check).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

`pg_trgm` is the only common trigram extension; the migration noops
if already enabled.

---

## 3. Repo layer

`lib/admin/audit.ts` (already exists from Spec 01 for **writes**)
gains read functions:

```ts
export interface AuditFilters {
  actorAdminId?: string;
  actionPrefix?: string;        // e.g. 'tenant.', 'plan.', 'impersonate.'
  targetKind?: string;
  targetId?: string;
  q?: string;                   // free-text on diff
  since?: Date;
  until?: Date;
  cursor?: string;              // base64({ id, occurredAt })
  limit?: number;               // default 50, cap 200
}

export async function listAuditRows(filters: AuditFilters): Promise<{
  data: AuditRow[];
  nextCursor: string | null;
}>;

export async function getAuditRow(id: string): Promise<AuditRow | null>;
```

Queries always read from the BYPASSRLS pool. No tenant scope.

`AuditRow` includes:

```ts
{
  id, adminEmail, action, targetKind, targetId,
  ip, userAgent,
  beforeJsonb, afterJsonb,
  occurredAt
}
```

---

## 4. API surface

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/admin/audit` | any admin | filters via querystring; cursor-paged |
| `GET` | `/api/admin/audit/[id]` | any admin | single row (used by the diff modal deep link) |

Both return JSON.

---

## 5. UI — `/admin/audit`

### 5.1 Filter row

Inline filter bar:

- Actor select (populated from `/api/admin/admins` for super_admin;
  ops_admin sees the list but can also filter by "Me" shortcut).
- Action prefix select with a small fixed dictionary:
  - All
  - Auth (`auth.*`)
  - Tenant (`tenant.*`)
  - Plan (`plan.*`)
  - Admin (`admin.*`)
  - Broadcast (`broadcast.*`)
  - Impersonation (`impersonate.*`)
- Target kind chip filter.
- Date range picker (default: last 14 days).
- Free-text search (`q`) — only fires after 400 ms debounce + min 3
  chars.

### 5.2 List table

Columns:

- Time (relative + absolute on hover).
- Actor email.
- Action.
- Target (kind + short id; clickable when it's a known kind like
  `tenant` → goes to `/admin/tenants/[id]`).
- IP.
- Diff summary — short snippet (e.g. `monthly_egp: 299 → 349`).
- Row click → modal.

Cursor pagination — "Load older" button at the bottom; no page
numbers.

### 5.3 Diff modal

When a row is opened:

- Header: action, actor, target link, occurred_at, IP, user-agent.
- Diff body: unified diff between `beforeJsonb` and `afterJsonb`
  rendered with a small in-repo JSON-diff helper (use the existing
  helper from Spec 04 if extracted; otherwise inline one here that
  handles primitive / array / object diffs).
- Each diff line is color-coded (red removed, green added, neutral
  unchanged).
- "Copy as JSON" button — copies `{ before, after }` to clipboard for
  pasting into a support ticket.

### 5.4 Empty states

- "No audit entries match this filter."
- Surface a subtle "Tip: try clearing the action filter or expanding
  the date range."

---

## 6. Edge cases

| Scenario | Behavior |
| --- | --- |
| Actor admin was deleted | UI renders `(deleted #abc12)` instead of email. |
| Target tenant was deleted | Target column shows `(deleted)` but the row still surfaces. |
| `before_jsonb` is null (creation actions) | Diff modal shows "Created" + `after_jsonb` as JSON. |
| `after_jsonb` is null (deletion actions) | Diff modal shows "Deleted" + `before_jsonb`. |
| Both null | Action shown without a diff (e.g. `impersonate.start` where before/after are recordkeeping). |
| 100k+ rows + no filter | Cursor pagination naturally limits each request to 50/200; no UI lock. |
| `q` matches inside an IP literal | Returns rows; we don't strip IP from the indexed text. |
| Free-text query is shorter than 3 chars | Client refuses; doesn't hit the server. |

---

## 7. Test plan

### Unit
- Filter combo SQL is parametrised (no injection).
- Cursor encoding round-trip.
- Diff helper: handles primitives, arrays, deeply nested objects,
  null on either side.

### Integration
- After Spec 03 writes a few suspend audits, list endpoint returns
  them in the right order.
- `actionPrefix=plan.*` returns only plan-related rows.
- Free-text on a JSON value finds matching rows via the GIN index
  (verify `EXPLAIN ANALYZE` uses the index).

### Playwright
- Admin opens `/admin/audit`, sees the recent suspend row from Spec 03,
  opens the diff modal, sees red/green diff lines.

---

## 8. Acceptance criteria

- [ ] All filters work in combination.
- [ ] Free-text search on a 100k-row table returns in < 250 ms.
- [ ] Diff modal renders before/after side by side correctly for
      every action category that wrote rows in Specs 03–07.
- [ ] Both `super_admin` and `ops_admin` can read the audit log.
- [ ] No write endpoint here — this spec is read-only.

---

## 9. Files this spec produces

```
lib/db/migrations/0036_admin_audit_search.sql
lib/admin/audit.ts                            (read functions added; writes already exist)

app/admin/audit/page.tsx
app/api/admin/audit/route.ts
app/api/admin/audit/[id]/route.ts

components/admin/AuditFilterBar.tsx
components/admin/AuditTable.tsx
components/admin/AuditDiffModal.tsx

lib/admin/json-diff.ts                        (small helper, used here + Spec 04 preview)

dictionaries/ar.json + en.json                (admin.audit.*)
```
