# Notification Phase B — architectural gaps

Two of the critical-channel events the plan asks for can't ship until the
schema grows a field. Each gap is **production-safe to defer**: the event
type + channel + sound mapping are already in place, so once the schema
lands, only the cron handler + producer wiring are left.

## 1. `attendance.late`

**What's missing.** There is no late-threshold or shift-start anywhere in the
tenant / shop_settings / tenant_members schema. Deciding whether an employee
is late requires a shift start per employee (or per shop) and a tolerance (how
many minutes past start counts as "late").

**Proposed smallest change.** Add two columns to `shop_settings`:
  - `work_day_start` (e.g. `"09:00"` as `time` or text)
  - `late_threshold_minutes` (default 10)

Then:
  - cron `attendance-late-sweep` runs every 15 min during work hours.
  - For each tenant: for each employee not yet checked in today AND
    `local_now >= work_day_start + late_threshold_minutes`, fire
    `attendance.late` with payload `{ employeeUserId, employeeName, lateByMin }`.
  - Dedupe link: `/team/<employeeId>/attendance?lateDate=YYYY-MM-DD`.
  - Channel: `critical` (already registered).

**Status today.** Event type + default preferences + channel/sound mapping
are not yet registered — if we need it before the schema lands we can push
`attendance.late` as `kind: "info"` which already routes to `generic`, but
the plan explicitly asks for `critical`, so hold until the schema change
ships.

## 2. `supplier.payment_due`

**What's missing.** `suppliers.balance_due` exists, but no due date anywhere.
Nothing in `expenses` or `purchase_orders` says "the shop owes the supplier
this amount by this date". Picking a date would be guesswork.

**Proposed smallest change.** Add one column to `expenses` (because
expenses already link to a supplier and are the natural ledger of owed
amounts):
  - `due_date` (nullable `date`) — set only when the operator entered one;
    overdue is `due_date < local_today AND NOT is_paid`.

Then:
  - cron `supplier-due-sweep` runs daily at 09:00 local.
  - For each tenant: aggregate per supplier the sum of unpaid `expenses`
    with `due_date < local_today` (and optionally `due_date = local_today`
    for a 1-day heads-up).
  - Fire `supplier.payment_due` with `{ supplierId, supplierName, amountOverdueEgp, overdueCount }`.
  - Dedupe link: `/suppliers/<id>?paymentDue=YYYY-MM-DD`.
  - Channel: `critical`.

**Status today.** Same as above — event type / channel mapping deferred
until the column is added. The UI gap (a date-picker on the expense form)
is smaller than the cron gap.

## Why not fake either one

Both events are **about the shop's money and staff** — the exact scenarios
the plan calls out as "critical". Firing them on a heuristic (e.g. "if no
check-in by local 10:00 send `.late`") would ring the owner's phone wrongly
on days with legitimate staff absence, which is strictly worse than not
firing at all. Same for supplier due: notifying on balance_due>0 would
light up every supplier every day. Hold until the schema change ships.
