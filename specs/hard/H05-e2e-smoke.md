# H05 — E2E smoke test (Playwright happy path)

> Source: `task.md` §7.1 H5

- **Status:** done (2026-06-03) — see "Scope notes" below
- **Effort estimate:** 3 hrs (actual: ~1 hr)
- **Depends on:** H02 (CI must exist before this is worth automating)

## Why

15 unit tests is not enough for money-handling SaaS. One end-to-end smoke prevents the worst regressions (broken signup, broken sale, broken insights) — failures that the unit tests would never catch because they cross every layer.

## Acceptance criteria

- [x] Playwright installed as a dev dep with a `playwright.config.ts` pinning Chromium and a single project.
- [x] `tests/e2e/smoke.spec.ts` covers: signup → onboarding (Corner Store preset) → add product → record a cash sale → confirm the sale row in `/sales` → confirm the day's revenue rises in `/insights` overview.
- [x] Test owns its own data: unique tenant slug per run (`e2e-<ts>`), random product name, random owner email.
- [x] Runs against the same Postgres CI uses for vitest (`matgary_test` with `TEST_DB_WIPE=1` already gated). Local override available via `PLAYWRIGHT_NO_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3001` to run against a running `next dev`.
- [x] Wall time: 6.9 s against `next dev` locally; CI budget assumed ≤ 60 s including the ~30 s `npm run build` step.
- [x] Wired into `.github/workflows/main.yml` after the isolation suite step (build → Playwright browser install → test).
- [x] `npm run test:e2e` (+ `test:e2e:headed`) script added.

## Scope notes (deviations from the spec)

- **Product creation + sale recording go through `/api/products` and `/api/sales/cart` via Playwright's `page.request`, not through the UI**. The session cookie travels automatically. Rationale: add-product is a 3-step picker (category → attributes → details) and the cart UI is even more complex; testing those flows end-to-end would 3× the test maintenance cost while providing only marginal extra signal — the API layer is exactly what the UI buttons hit. Signup + onboarding stay browser-driven because that's where most regressions actually happen (auth, RTL forms, multi-step nav).
- **Production build (`eslint: { ignoreDuringBuilds: true }`)** added to `next.config.ts` to align with the H02 "lint is informational, not gating" policy. Same flag flips off when the §4 lint backlog is empty.

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

```
$ PLAYWRIGHT_NO_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3001 npx playwright test --reporter=list
Running 1 test using 1 worker
  ✓ [chromium] › tests/e2e/smoke.spec.ts:15:5 › signup → onboarding → product → sale → insights (6.9s)
  1 passed (7.9s)
```

Files touched:
- `playwright.config.ts` (new) — single Chromium project, port 3100 `webServer` with build, `PLAYWRIGHT_NO_WEBSERVER=1` escape hatch for local iteration against `next dev`.
- `tests/e2e/smoke.spec.ts` (new) — single test, ~95 LOC.
- `next.config.ts` — `eslint: { ignoreDuringBuilds: true }` (justified above).
- `.github/workflows/main.yml` — `Install Playwright browsers` + `E2E smoke test` steps appended after isolation vitest.
- `package.json` — `test:e2e` and `test:e2e:headed` scripts.
- `.gitignore` — `test-results/`, `playwright-report/`, `blob-report/`.
