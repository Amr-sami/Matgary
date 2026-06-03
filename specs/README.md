# Specs

Working surface for the launch-readiness work. Each spec lives in its own file so progress, implementation notes, and verification log can travel with it.

- `hard/` — must finish before paid launch. Status canonical: this folder.
- Soft & External buckets stay summarised in `task.md` §7.2 / §7.3 until promoted.

## Hard spec index

| ID | Title | Status | Effort |
|---|---|---|---|
| [H01](hard/H01-restore-drill.md) | Restore drill execution | ✅ done 2026-06-03 | 30 min |
| [H02](hard/H02-ci-pipeline.md) | CI pipeline (GitHub Actions) | ✅ done 2026-06-03 | 1-2 hrs |
| [H03](hard/H03-2fa.md) | 2FA for owners (TOTP + recovery codes) | pending | 3-4 hrs |
| [H04](hard/H04-health-endpoints.md) | /healthz + /readyz endpoints | ✅ done 2026-06-03 | 30 min |
| [H05](hard/H05-e2e-smoke.md) | E2E smoke test (Playwright) | ✅ done 2026-06-03 | 3 hrs |
| [H06](hard/H06-money-math-tests.md) | Repo-level unit tests for money math | ✅ done 2026-06-03 (leave-overlap dropped) | 2 hrs |
| [H07](hard/H07-pre-pentest-hardening.md) | Pre-pentest security hardening pass | pending | 4-6 hrs |
| [H08](hard/H08-csp.md) | CSP headers | pending | 1-2 hrs |
| [H09](hard/H09-session-revocation.md) | Session revocation ("sign out everywhere") | pending | 1-2 hrs |
| [H10](hard/H10-pwd-reset-throttle.md) | Password reset throttle by email | ✅ done 2026-06-03 | 30 min |
| [H11](hard/H11-pdpl-export.md) | PDPL data-export endpoint | pending | 3-4 hrs |
| [H12](hard/H12-account-deletion.md) | Real account deletion + 30-day grace | pending | 4-5 hrs |

Execution order is `task.md` §7.4 (H1 → H4 → H10 → H2 → H6 → H5 → H3 → H9 → H8 → H11 → H12 → H7).

## Spec file conventions

- **Status** values: `pending` → `in-progress` → `done` (or `blocked: <reason>`).
- Acceptance criteria are markdown checkboxes. The spec is `done` only when every box is checked.
- **Implementation notes** is appended during the work — file paths touched, decisions, gotchas.
- **Verification log** records the commands that proved acceptance, plus their output (trimmed).
- On completion: flip status, add a changelog entry in `task.md` §2, update this index, and reference the spec from the commit.
