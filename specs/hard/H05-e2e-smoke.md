# H05 — E2E smoke test (Playwright happy path)

> Source: `task.md` §7.1 H5

- **Status:** pending
- **Effort estimate:** 3 hrs
- **Depends on:** H02 (CI must exist before this is worth automating)

## Why

15 unit tests is not enough for money-handling SaaS. One end-to-end smoke prevents the worst regressions (broken signup, broken sale, broken insights) — failures that the unit tests would never catch because they cross every layer.

## Acceptance criteria

- [ ] Playwright installed as a dev dep with a `playwright.config.ts` pinning Chromium and a single project.
- [ ] `tests/e2e/smoke.spec.ts` covers: signup → onboarding (Corner Store preset) → add product → record a cash sale → confirm the sale row in `/sales` → confirm the day's revenue rises in `/insights` overview.
- [ ] Test owns its own data: unique tenant slug per run (`smoke-<ts>`), random product SKU, random owner email.
- [ ] Runs against a dockerized Postgres wiped before each run with the same `TEST_DB_WIPE=1` + `DATABASE_URL contains "test"` double-gate as Vitest.
- [ ] Wall time under 60 s on CI.
- [ ] Wired into `.github/workflows/main.yml` after the isolation suite step.
- [ ] `npm run test:e2e` script added.

## Implementation plan

1. `npm i -D @playwright/test`, `npx playwright install chromium`.
2. Config: `webServer: { command: "npm run start", port: 3000, reuseExistingServer: !process.env.CI }`. Production server, not dev — keeps the test honest about prod behaviour.
3. Spec uses Playwright's `request.newContext()` only for the signup POST (since the signup form uses a server action — easier to drive via UI); rest is browser interaction.
4. Selectors prefer `getByRole` + accessible names; fall back to `data-testid` only where Arabic UI labels would be brittle.
5. CI step provisions DB + roles + migrations identical to H02's `main.yml`, then `npm run build && npm run start &` in the background before `playwright test`.

## Out of scope

- Multi-tenant interleaving (already covered by isolation suite).
- WhatsApp send (involves real Green API creds).
- Payment flow (E3 gated).
- Mobile viewport.

## Risks & gotchas

- Server actions don't play well with Playwright's request interception — drive through the UI for state-mutating steps.
- RTL Arabic UI: selectors based on visible text need exact Arabic strings; consider `data-testid` on the 5-6 critical buttons.
- Build time in CI adds ~1-2 min — accept it; the alternative (dev server) would mask production-only bugs.

## Verification log

(populated during execution)
