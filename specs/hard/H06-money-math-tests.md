# H06 — Repo-level unit tests for money math

> Source: `task.md` §7.1 H6

- **Status:** done (2026-06-03) — leave-overlap row dropped, see "Real finding" below.
- **Effort estimate:** 2 hrs (actual: ~45 min)
- **Depends on:** H02 (so tests run in CI from day 1)

## Why

Discount math, payroll period calc, and leave-date overlap are three places a silent bug costs real money. Today these are tested only through manual UI runs. Each gets a focused unit test against `lib/repo/*` functions directly — no UI, no HTTP layer.

## Acceptance criteria

- [x] `tests/repo/sale-discounts.test.ts`:
  - [x] Line discount only (% and absolute EGP).
  - [x] Order discount only (% and absolute EGP).
  - [x] Line + order stacked — order applies after lines.
  - [x] Free-item edge: line total 0 doesn't divide-by-zero anywhere.
  - [x] Rounding direction: `Math.round` half-up — confirmed against the production path and locked in (`333 * 10% → 33`, `335 * 10% → 34`).
- [x] `tests/repo/payroll-period.test.ts`:
  - [x] Fixed pay, full period: pro-rated by days worked / days in month.
  - [x] Hourly, no attendance: returns 0 (not error).
  - [x] Hourly weekday: regular hours at base rate.
  - [x] Hourly overtime: hours over `workHoursPerDay` at the multiplier.
  - [x] Weekend-as-OT: every hour on a weekend day bills as OT.
  - [x] Hybrid: base monthly pro-rated + OT-only hourly leg.
  - [x] Mid-period rate change: comp row effective on each shift's start date wins.
- [ ] ~~`tests/repo/leave-overlap.test.ts`~~ — **dropped.** See "Real finding" below.
- [x] All landed suites run in ~10 ms combined (well under the 2 s budget).
- [x] Wired into PR workflow via `npx vitest run ... tests/repo/`.

## Real finding (surfaced by this spec)

The leave-overlap test couldn't be written because the codebase has **no leave-overlap detection at all**. `lib/repo/leave-requests.ts:submitLeaveRequest` only enforces `startDate <= endDate`. The same employee can submit (and an owner can approve) two overlapping leaves with no warning anywhere.

Decision: testing math that does not exist would be theatre. The right move is to **implement** overlap detection, then test it — that's now tracked separately in `task.md` §4 ("Leave overlap detection") and listed in §5 known gaps. Estimated half-day to implement + add the unit + integration tests.

## Implementation plan

1. Find the pure functions inside `lib/repo/operations.ts` (sale recording / discount calc) and `lib/repo/payroll.ts` and `lib/repo/leave-requests.ts`.
2. Where logic is tangled with DB access, extract the pure subset (calc-only) into a sibling helper and unit-test that — repo functions can pass through to it. **No mocking the DB.**
3. Property-based tests not required; table-driven is fine and easier to read.

## Out of scope

- Integration tests of the full sale POST endpoint (E2E covers this in H05).
- Currency conversion (single-currency EGP for now).
- Multi-branch ledger interactions (separate spec under §7.2 backlog).

## Risks & gotchas

- The "rounding direction" question may surface a real bug — receipt PDF and insights may disagree by 0.01 EGP today. If so, file a separate fix task and lock the test to the **correct** direction, not the current one.

## Verification log

```
$ npx vitest run tests/cache.test.ts tests/ratelimit.test.ts tests/repo/
 ✓ tests/repo/sale-discounts.test.ts (13 tests) 3ms
 ✓ tests/repo/payroll-period.test.ts (10 tests) 3ms
 ✓ tests/ratelimit.test.ts (3 tests) 26ms
 ✓ tests/cache.test.ts (4 tests) 55ms
 Test Files  4 passed (4)
      Tests  30 passed (30)
```

Files touched:
- `lib/repo/sale-discounts.ts` (new) — pure `calcLineDiscount`, `calcOrderDiscount`, `calcCartTotals`.
- `lib/repo/payroll-compute.ts` (new) — pure `computeGrossFromShifts`, plus `CompensationDto` + `pickEffectiveCompensation` relocated here to break what would have been a circular import.
- `lib/repo/operations.ts` — delegates to `calcLineDiscount` / `calcOrderDiscount` at the 3 historical inline-math sites.
- `lib/repo/payroll.ts` — `computePeriodGross` now fetches data and delegates to `computeGrossFromShifts`; re-exports `CompensationDto` + `PayType` + `pickEffectiveCompensation` for backwards compatibility.
- `tests/repo/sale-discounts.test.ts` (new) — 13 tests.
- `tests/repo/payroll-period.test.ts` (new) — 10 tests.
- `.github/workflows/pr.yml` — extended unit-test step to include `tests/repo/`.

### Why extraction was in scope

The H06 spec explicitly authorised it: "Where logic is tangled with DB access, extract the pure subset (calc-only) into a sibling helper and unit-test that. **No mocking the DB.**" Production behaviour is byte-identical to pre-refactor.
