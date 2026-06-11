# Cash Reconciliation & Z-Report — Spec

Owner: Amr · Drafted: 2026-06-10

End-of-shift drawer count, expected vs counted, variance recorded, owner
review. The #1 shrinkage-detection tool every mature POS has and we don't.
Designed to layer onto the existing multi-store + attendance + permissions
plumbing without new infra.

---

## 1. Goal

For every cashier shift at every branch, prove that the cash that left
the drawer matches the cash recorded by the system. Surface variances
to the owner with enough context to act (which cashier, which shift,
which transactions).

**Acceptance** — by the end of v1:

- A cashier can't take cash sales without first opening a shift.
- "Close shift" requires entering a counted_cash; the resulting Z-report
  is printable / exportable.
- Any non-zero variance ≥ ₤1 surfaces in an owner inbox until reviewed.
- Sales that get edited or refunded after close do **not** retroactively
  change a closed shift's expected_cash — the snapshot is frozen.
- Multi-branch + multi-cashier on the same branch coexist cleanly (each
  cashier owns their own shift).

---

## 2. Domain model

### 2.1 Shift lifecycle

```
[open] --counted+confirm--> [closed] --owner review--> [reviewed]
   |
   +--owner force-close--> [closed] (counted=null, reason='auto')
```

### 2.2 Rules

- Exactly **one open shift per (tenant, branch, cashier)**. Enforced by a
  partial unique index.
- A branch can have multiple concurrent shifts (one per active cashier
  at multi-register branches).
- Owner-recorded sales (no cashier) attach to a synthetic "owner desk"
  shift auto-opened the first time the owner records a cash sale that
  day and auto-closed at midnight (tenant tz).
- Refunds, expenses, and cash movements created **during** an open shift
  are linked to that shift. After close they go to the current open
  shift (or the owner-desk shift) — never retro-linked.

### 2.3 Expected-cash formula

```
expected = opening_float
         + Σ cash sale totals during shift
         - Σ cash refund payouts during shift
         + Σ cash_in movements
         + Σ paid_in movements          (owner deposit into drawer)
         - Σ cash_out movements
         - Σ paid_out movements         (owner withdrawal from drawer)
         - Σ cash-paid expenses during shift
```

`variance = counted_cash - expected`

- `|variance| < 1 EGP` → balanced (green badge).
- `variance ≤ -1 EGP` → shortage (red, requires review).
- `variance ≥ +1 EGP` → overage (yellow, also requires review — overages
  matter too: they're either an unrecorded sale or an opening miscount).

The 1-EGP tolerance absorbs rounding without burying real signal.

---

## 3. Data model

### 3.1 Migration `0032_cash_shifts.sql`

```sql
CREATE TABLE cash_shifts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  cashier_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  status          text NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'closed', 'reviewed')),

  opened_at       timestamptz NOT NULL DEFAULT now(),
  opened_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opening_float   numeric(12,2) NOT NULL DEFAULT 0
                   CHECK (opening_float >= 0),
  opening_note    text,

  closed_at       timestamptz,
  closed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  expected_cash   numeric(12,2),
  counted_cash    numeric(12,2),
  variance        numeric(12,2) GENERATED ALWAYS AS (counted_cash - expected_cash) STORED,
  closing_note    text,
  close_reason    text,        -- 'cashier' | 'auto_midnight' | 'forced'

  reviewed_at     timestamptz,
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  review_note     text,

  -- Frozen snapshot of all sale/expense aggregates at close. Lets the
  -- Z-report stay stable even if a sale is later edited or returned.
  -- Shape documented in §6.4.
  totals_snapshot jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cash_shifts_tenant_branch_date_idx
  ON cash_shifts (tenant_id, branch_id, opened_at DESC);
CREATE INDEX cash_shifts_tenant_cashier_idx
  ON cash_shifts (tenant_id, cashier_user_id, opened_at DESC);
CREATE INDEX cash_shifts_review_queue_idx
  ON cash_shifts (tenant_id, status, variance)
  WHERE status = 'closed' AND abs(variance) >= 1;
CREATE UNIQUE INDEX cash_shifts_one_open_per_cashier
  ON cash_shifts (tenant_id, branch_id, cashier_user_id)
  WHERE status = 'open';

-- RLS — same pattern every other tenant-scoped table uses.
ALTER TABLE cash_shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY cash_shifts_tenant_isolation ON cash_shifts
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);


CREATE TABLE cash_movements (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id   uuid NOT NULL REFERENCES cash_shifts(id) ON DELETE CASCADE,

  -- cash_in: misc cash deposited (e.g. customer paid an old deferred)
  -- cash_out: misc cash taken out (e.g. owner change-fund top-up)
  -- paid_in: owner deposits cash INTO the drawer
  -- paid_out: owner withdraws cash FROM the drawer (banking, supplier petty)
  kind       text NOT NULL
              CHECK (kind IN ('cash_in', 'cash_out', 'paid_in', 'paid_out')),
  amount     numeric(12,2) NOT NULL CHECK (amount > 0),
  reason     text NOT NULL,         -- non-null: every movement needs a why
  recorded_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cash_movements_shift_idx ON cash_movements (shift_id, recorded_at);
CREATE INDEX cash_movements_tenant_idx ON cash_movements (tenant_id, recorded_at);

ALTER TABLE cash_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY cash_movements_tenant_isolation ON cash_movements
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);


-- Sales/expenses linkage. Nullable for legacy + non-cash + owner-desk fallback.
ALTER TABLE sales    ADD COLUMN cash_shift_id uuid REFERENCES cash_shifts(id) ON DELETE SET NULL;
ALTER TABLE expenses ADD COLUMN cash_shift_id uuid REFERENCES cash_shifts(id) ON DELETE SET NULL;
ALTER TABLE returns  ADD COLUMN cash_shift_id uuid REFERENCES cash_shifts(id) ON DELETE SET NULL;

CREATE INDEX sales_cash_shift_idx    ON sales    (cash_shift_id) WHERE cash_shift_id IS NOT NULL;
CREATE INDEX expenses_cash_shift_idx ON expenses (cash_shift_id) WHERE cash_shift_id IS NOT NULL;
CREATE INDEX returns_cash_shift_idx  ON returns  (cash_shift_id) WHERE cash_shift_id IS NOT NULL;
```

### 3.2 Permissions

Add to `lib/permissions.ts`:

| Permission | Default holder | Meaning |
| --- | --- | --- |
| `open_close_shift` | cashier | Open own shift, record movements, close own shift. |
| `manage_cash_reconciliation` | owner / manager | Cross-cashier list, owner review, force-close, void variance. |

Owner role bypasses both (per existing `can()` rule).

---

## 4. Computation

Repo `lib/repo/cash-shifts.ts` exposes:

```ts
// Pure computation — used both at /current (live) and at close (snapshot).
async function computeShiftCashFlow(
  tx: Tx,
  tenantId: string,
  shiftId: string,
): Promise<{
  openingFloat: string;
  cashSales: string;          // sum of sales.totalPrice where paymentMethod='cash'
  cashRefunds: string;        // sum of cash-paid returns
  cashIn: string;
  cashOut: string;
  paidIn: string;
  paidOut: string;
  cashExpenses: string;       // sum of cash-paid expenses
  expectedCash: string;       // computed from the above
  byMethod: { cash: string; card: string; instapay: string; deferred: string };
  saleCount: number;
  returnCount: number;
  topProducts: { name: string; qty: number; revenue: string }[]; // top 3
}>;
```

All arithmetic happens server-side in `numeric(12,2)` via `SUM(...)::text`
— the client never adds floats. Numbers travel as strings end-to-end,
same convention `lib/repo/operations.ts` already uses.

---

## 5. Workflows

### 5.1 Open shift — cashier

1. Cashier hits POS or any cash-recording route without an open shift.
   Middleware-side guard (`requireOpenShift()`) returns 409
   `{ code: 'NO_OPEN_SHIFT' }`.
2. Client shows **Open shift** modal:
   - Opening float input (default = last closed shift's `counted_cash`
     for same (branch, cashier), else 0).
   - Optional note ("started with 500 from yesterday").
3. `POST /api/cash-shifts` → 201 `{ shift }`.
4. Drawer widget appears in the top nav (live expected cash).

### 5.2 Mid-shift movement

- "Drawer" panel slide-over has 4 buttons: paid_in / paid_out / cash_in
  / cash_out, each requiring `amount` + `reason`.
- `POST /api/cash-shifts/:id/movements` with `{ kind, amount, reason }`.
- Recorded immediately; live `expectedCash` recomputes.
- Visible in shift detail timeline.

### 5.3 Close shift — cashier

1. Cashier clicks **Close shift** in drawer panel.
2. Modal shows current `expectedCash` (computed live).
3. Cashier counts the physical drawer and enters `countedCash`.
   Optional: denomination grid (200 × N, 100 × N, ...) sums for them
   — v1 skips this and just takes a number.
4. Optional `closingNote` (mandatory if |variance| ≥ ₤50).
5. Confirm → `POST /api/cash-shifts/:id/close` body
   `{ countedCash, closingNote? }`.
6. Server runs `computeShiftCashFlow` under a transaction, snapshots into
   `totals_snapshot`, sets `expected_cash`, `counted_cash`, `closed_at`,
   `closed_by_user_id`, `close_reason='cashier'`, `status='closed'`.
7. Response is the Z-report payload — client navigates to
   `/cash-shifts/:id` showing the report with **Print** and
   **Download CSV** buttons.

### 5.4 Owner review

- Closed shifts with `|variance| ≥ 1` appear in `/cash-shifts?status=needs_review`.
- Dashboard widget: "3 shifts need review · ₤120 net shortage today".
- Owner opens shift → reviews snapshot + timeline → **Mark reviewed**
  with optional `reviewNote`.
- `POST /api/cash-shifts/:id/review` → `status='reviewed'`.

### 5.5 Force-close (owner)

- Any shift open > 24 h triggers a notification:
  `kind='shift_left_open'` to all `manage_cash_reconciliation` holders.
- Owner can force-close from the shift detail page:
  `POST /api/cash-shifts/:id/force-close` with mandatory `reason`.
- Server sets `counted_cash = NULL`, `expected_cash = computed`,
  `close_reason = 'forced'`, `closing_note = reason`,
  `closed_by_user_id = caller`. Variance stays NULL (not counted).
- These show in the review queue with a distinct "force-closed" badge.

### 5.6 Owner-desk auto-shift

- When the owner (no `cashier_user_id` flow) records a cash sale and
  no open shift exists for them at the current branch:
  - Server auto-creates a shift with `opening_float=0`,
    `cashier_user_id=owner.id`, `opening_note='owner desk (auto)'`.
- At 00:00 in tenant tz, a small cron sweep auto-closes any such shift
  whose only activity was that day: sets `counted_cash=expected_cash`,
  `close_reason='auto_midnight'`. No variance ever recorded; it's a
  bookkeeping container, not a real drawer.
- Owners get the option in `/settings/cash-drawer` to disable auto-shift
  and force themselves through the normal open/close flow.

---

## 6. API

### 6.1 Endpoint table

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| `GET`  | `/api/cash-shifts` | `manage_cash_reconciliation` for cross-cashier; staff get their own | filters: `status`, `cashierId`, `branchId`, `from`, `to`, `needsReview=1` |
| `GET`  | `/api/cash-shifts/current` | any logged-in cashier-capable user | returns own open shift or `null` |
| `POST` | `/api/cash-shifts` | `open_close_shift` | body `{ openingFloat, openingNote? }` |
| `GET`  | `/api/cash-shifts/:id` | shift owner OR `manage_cash_reconciliation` | full detail incl. live or snapshot totals |
| `POST` | `/api/cash-shifts/:id/movements` | shift owner OR `manage_cash_reconciliation` | body `{ kind, amount, reason }` |
| `GET`  | `/api/cash-shifts/:id/movements` | same | list |
| `POST` | `/api/cash-shifts/:id/close` | shift owner OR `manage_cash_reconciliation` | body `{ countedCash, closingNote? }` |
| `POST` | `/api/cash-shifts/:id/review` | `manage_cash_reconciliation` | body `{ reviewNote? }` |
| `POST` | `/api/cash-shifts/:id/force-close` | `manage_cash_reconciliation` | body `{ reason }` (required) |
| `GET`  | `/api/cash-shifts/:id/z-report` | shift owner OR `manage_cash_reconciliation` | `Accept: text/csv` for export, default JSON |
| `GET`  | `/api/cash-shifts/:id/sales` | shift owner OR `manage_cash_reconciliation` | paginated list of sales/refunds/expenses on this shift |

### 6.2 Cross-cutting writes

`recordCartSale` and `recordExpense` (in `lib/repo/operations.ts`) gain
an internal step that looks up the caller's current open shift for the
branch and stamps `cash_shift_id`:

```ts
async function resolveShiftStamp(tx, tenantId, branchId, recordedByUserId, paymentMethod) {
  // Stamp only when the payment method touches cash. Skip card/instapay/deferred.
  if (paymentMethod !== 'cash') return null;
  const open = await openShiftFor(tx, tenantId, branchId, recordedByUserId);
  if (open) return open.id;
  // Owner-desk auto-create (see §5.6) for owner role only.
  if (isOwner(...)) return autoOpenOwnerDeskShift(tx, ...);
  // Cashier with no open shift → throw, route returns 409 NO_OPEN_SHIFT.
  throw new NoOpenShiftError();
}
```

The check is **only** applied to cash-affecting writes. Card / instapay
sales don't need a shift — those payment rails reconcile themselves.

### 6.3 Idempotency

- `POST /api/cash-shifts` uses the partial unique index as the
  idempotency guarantor: a second open in a race throws → return
  the existing open shift instead of erroring.
- `POST .../close` re-reads `status` inside the txn; if already closed,
  return the existing Z-report payload (200, not 409).

### 6.4 Snapshot shape

`cash_shifts.totals_snapshot`:

```jsonc
{
  "cashFlow": {
    "openingFloat": "500.00",
    "cashSales": "8200.00",
    "cashRefunds": "0.00",
    "cashIn": "0.00",
    "cashOut": "0.00",
    "paidIn": "0.00",
    "paidOut": "200.00",
    "cashExpenses": "150.00",
    "expectedCash": "8350.00"
  },
  "byMethod": {
    "cash":     { "count": 12, "total": "8200.00" },
    "card":     { "count":  3, "total": "2100.00" },
    "instapay": { "count":  2, "total":  "950.00" },
    "deferred": { "count":  1, "total":  "500.00" }
  },
  "counts": { "sales": 18, "returns": 0, "expenses": 2 },
  "topProducts": [
    { "name": "ساعة Casio MTP", "qty": 3, "revenue": "4350.00" },
    { "name": "نظارة Police Pilot", "qty": 2, "revenue": "2600.00" }
  ],
  "computedAt": "2026-06-10T21:14:00Z",
  "version": 1
}
```

Version stamped so a future schema change can read old snapshots.

---

## 7. UI surfaces

### 7.1 POS topbar drawer chip

Right-most element next to the branch picker:

```
🧾 Drawer · ₤2,150 expected · open since 09:14
```

Click → slide-over drawer panel.

### 7.2 Drawer panel (slide-over)

- Live `expectedCash` recomputed every 30 s and after each movement.
- "Add movement" — 4 buttons (paid_in / paid_out / cash_in / cash_out).
- Timeline: sales / refunds / movements chronologically with running balance.
- **Close shift** button (sticky bottom).

### 7.3 Close-shift modal

- Big `expectedCash` number.
- `countedCash` input (numeric pad on mobile).
- Variance preview (red/green/yellow) as cashier types.
- Note textarea (required if |variance| ≥ ₤50).
- Confirm button disabled until counted_cash is a valid number.

### 7.4 Z-report page (`/cash-shifts/[id]`)

- Header: branch · cashier · opened at · closed at · duration · status badge.
- Cash-flow ladder (the formula §2.3 rendered as a stack).
- Variance highlight + closing/review notes.
- Sales table (linked to sale detail).
- Movements table.
- **Print** (browser print stylesheet for thermal printer) and
  **Download CSV** buttons.
- Owner-only **Mark reviewed** button when status=closed and
  `|variance| ≥ 1`.

### 7.5 Manager list (`/cash-shifts`)

- Filter chips: status, cashier, branch, date range, "needs review only".
- Table columns: cashier · branch · opened · closed · expected · counted ·
  variance (with colored badge) · status.
- Click row → Z-report.

### 7.6 Dashboard widget (owner home)

```
Today's shifts
  ▲ 3 closed · ₤45 net shortage
  ✗ 1 still open (sara @ main, since 09:14 → 13:20)
  → 2 need review
```

Click → `/cash-shifts?date=today`.

---

## 8. Edge cases

| Scenario | Behavior |
| --- | --- |
| Cashier signs out without closing | Shift stays open. On next login, banner: "you have an open shift from yesterday — close it before recording new sales." Cashier can still close from any device. |
| Cashier records cash sale before opening | Server returns 409 `NO_OPEN_SHIFT`. Client shows the Open-shift modal inline, retries the sale after open. |
| Cash refund after the originating shift closed | Refund goes to the **current** open shift's expected_cash (or owner-desk shift). The closed shift's snapshot is untouched. Visible in the new shift's timeline with "(refund of sale #X from prev shift)" note. |
| Sale edited after shift close | Snapshot frozen — closed shift is the source of truth for that day. The edit shows in the current shift's activity log. |
| Two cashiers, one branch | Independent shifts. Each can only see/close their own. Manager view shows both side by side. |
| Owner records cash sale | Owner-desk shift auto-opens (§5.6). |
| Shift left open > 24 h | Notification fired hourly until force-closed. Next cashier on same drawer is **not blocked** — they open their own shift on the same branch (multi-cashier model). |
| Migration backfill | Existing legacy sales/expenses keep `cash_shift_id = NULL`. They never appear in a Z-report (would distort variance). Owners can run a one-off "backfill into owner-desk shifts" tool from `/settings/cash-drawer` if they want history. |
| Cashier deleted/disabled mid-shift | Shift stays open, but the user can no longer log in. Owner can force-close. |
| Cashier moves to another branch | Their open shift at old branch stays open; they can't open a new one until that's closed. Forces clean handoff. |
| Negative opening float typed | Schema CHECK blocks at DB; UI disables submit. |
| Counted cash = expected to the cent | Status closed, variance=0, no review queue entry. Best-case path. |

---

## 9. Activity log + notifications

- `cash_shift.open` — actor=cashier, metadata={ openingFloat }.
- `cash_shift.movement` — actor=user, metadata={ kind, amount, reason }.
- `cash_shift.close` — actor=cashier, metadata={ expected, counted, variance, snapshotVersion }.
- `cash_shift.force_close` — actor=owner, metadata={ reason, expected }.
- `cash_shift.review` — actor=owner, metadata={ note }.

Notifications:
- `shift_variance` — fired on close when |variance| ≥ 1, recipients =
  all users with `manage_cash_reconciliation`. Body includes cashier,
  branch, amount, link `/cash-shifts/:id`.
- `shift_left_open` — fired hourly by cron for any shift open > 24 h.

---

## 10. Cron / sweeps

Two cron endpoints, same `CRON_SECRET` pattern as
`/api/cron/recurring-expenses`:

- `POST /api/cron/cash-shift-sweep` — hourly:
  - Fire `shift_left_open` for shifts where
    `opened_at < now() - interval '24 hours'` AND `status='open'`.
  - Auto-close owner-desk shifts whose `business_date < today` in tenant
    tz (see §5.6).

---

## 11. Out of scope (v1)

- Denomination grid in the close-shift modal (count of 200/100/50/...).
- Multi-currency drawer.
- Auto-suggest physical deposit when drawer > X.
- Drop-safe deposits (cash you stash mid-shift without exiting it).
- Per-shift inventory mini-count.
- Reconciliation against card processor settlement reports.

---

## 12. Test plan

### 12.1 Unit (repo)

- `computeShiftCashFlow` — every term of the formula independently
  contributes to expected.
- Partial unique index prevents two open shifts for same (branch, cashier).
- Snapshot is frozen: edit a sale after close → snapshot unchanged.

### 12.2 Integration (HTTP)

- Open → 3 cash sales → 1 instapay sale → 1 expense → close with exact
  match → variance = 0, status=closed, no notification.
- Open → 2 cash sales → cash_out 50 → close with counted = expected - 50
  → variance = -50, notification fired.
- Force-close shift open > 24 h → status=closed, close_reason=forced,
  variance=NULL.
- Owner-desk auto-shift: owner records cash sale with no shift → shift
  auto-opens → cron at midnight auto-closes it.
- Refund after originating shift closed → refund lands on current shift,
  old snapshot untouched.

### 12.3 RLS

- Cashier from tenant A cannot read tenant B's shifts (even by guessing IDs).
- Cashier with `open_close_shift` cannot review (manager-only path).

### 12.4 UX (Playwright)

- Cashier tries to ring up a cash sale before opening → modal pops →
  fills opening float → modal closes → sale completes.
- Close-shift wizard: type counted, see variance preview update.
- Print Z-report renders within thermal-printer column width.

---

## 13. Rollout plan

1. **Migration 0032** — empty tables, no data movement.
2. **Repo + API** — implement everything behind a feature flag
   `cash_reconciliation_enabled` on shop_settings (default OFF for
   existing tenants, ON for new signups).
3. **UI** — drawer chip + close wizard + manager list + Z-report page.
4. **Soft launch** to samyamr819 tenant only (feature flag flip) for a
   week. Iterate on copy + edge cases.
5. **Default ON** for all tenants once stable. Existing legacy sales
   keep `cash_shift_id=NULL` (don't show up in Z-reports).

---

## 14. Open questions

- Do we need per-cashier permission OR is `record_sales` enough?
  (Lean: separate `open_close_shift` so a stockroom person who has
  `manage_inventory` but no POS access can't accidentally open a shift.)
- Should non-cash sales also be linked to a shift for analytics? v1:
  no — keeps the shift purely about cash. Sales-by-cashier reports
  already exist independently.
- Variance threshold for "must add a note" — ₤50 a sensible default?
  Make it `shop_settings.cash_variance_note_threshold` configurable.
