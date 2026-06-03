# H06 — Repo-level unit tests for money math

> Source: `task.md` §7.1 H6

- **Status:** pending
- **Effort estimate:** 2 hrs
- **Depends on:** H02 (so tests run in CI from day 1)

## Why

Discount math, payroll period calc, and leave-date overlap are three places a silent bug costs real money. Today these are tested only through manual UI runs. Each gets a focused unit test against `lib/repo/*` functions directly — no UI, no HTTP layer.

## Acceptance criteria

- [ ] `tests/repo/sale-discounts.test.ts`:
  - [ ] Line discount only (% and absolute EGP).
  - [ ] Order discount only (% and absolute EGP).
  - [ ] Line + order stacked — order applies after lines.
  - [ ] Free-item edge: line total 0 doesn't divide-by-zero anywhere.
  - [ ] Rounding direction matches receipt + insights (banker's vs round-half-up — pick what receipts use and lock it).
- [ ] `tests/repo/payroll-period.test.ts`:
  - [ ] Fixed pay, full period: returns the base.
  - [ ] Hourly, no attendance: returns 0 (not error).
  - [ ] Hourly with mixed approved/missed days: only approved hours counted.
  - [ ] Hybrid (fixed + per-hour overtime): both legs sum correctly.
  - [ ] Mid-period rate change via effective-from versioning: pre-change days use old rate, post-change use new.
- [ ] `tests/repo/leave-overlap.test.ts`:
  - [ ] Same-employee fully-overlapping submitted leave is detected.
  - [ ] Same-employee adjacent (end-of-A == start-of-B) is NOT overlap.
  - [ ] Cross-employee overlap is NOT flagged.
  - [ ] Approved + submitted both count toward overlap; rejected does not.
- [ ] All three suites run in <2 s combined.
- [ ] Wired into PR workflow (no separate command needed — `npx vitest run` picks them up).

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

(populated during execution)
