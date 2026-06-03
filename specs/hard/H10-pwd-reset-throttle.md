# H10 — Password reset throttle by email

> Source: `task.md` §7.1 H10

- **Status:** done (2026-06-03)
- **Effort estimate:** 30 min (actual: ~20 min)
- **Depends on:** none

## Why

§5 noted today's throttle is IP-only — an attacker rotating IPs could use the forgot-password endpoint to learn which emails are users (existence oracle via response timing or follow-up signals). Always-200 + bcrypt-on-unknown helps, but a per-email throttle is belt + suspenders.

## Acceptance criteria

- [x] New rate-limit bucket `pwd.forgot.email` 3 / 1 hr, keyed on `sha256(email_lower)`.
- [x] Bucket consumed BEFORE database lookup — same timing for known + unknown emails. — `emailRl` check sits between `email.trim().toLowerCase()` and `issueResetToken(email)`.
- [x] Consumed even on unknown emails (so timing/count doesn't leak existence). — consumption is unconditional; the only outward effect of exceeding is internally skipping `issueResetToken` + `sendMail`.
- [x] IP bucket (`pwd.forgot`) preserved — both must pass.
- [x] Always-200 outward shape preserved — over-limit path returns `{ok:true}` identical to the success path.
- [x] Bucket fail-open behaviour preserved (Redis down → request still processes) — inherited from `rateLimit()` (returns `{ok:true}` when `redis === null`).
- [x] Unit test verifies 3-then-block and per-hash isolation. — `tests/ratelimit.test.ts`, 3 tests, all green.

## Implementation plan

1. `lib/ratelimit.ts` — bucket config addition.
2. `app/api/account/password/forgot/route.ts` — add a `rateLimitConsume("pwd.forgot.email", sha256(email))` call right after parsing the email. If exceeded, skip the DB read + token issue + email send. Still return 200 with the always-success body.
3. Test: integration test that ensures Redis ZSET grows by 1 per call.

## Out of scope

- Per-user lockout after too many resets (separate spec).
- CAPTCHA on the forgot form (later if abuse appears).

## Risks & gotchas

- Hash the email; storing raw emails in Redis keys is a leak vector.
- Test must lowercase before hashing — same email in different case should be the same bucket.

## Verification log

```
$ npx vitest run tests/ratelimit.test.ts
 ✓ tests/ratelimit.test.ts (3 tests) 27ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

Files touched:
- `app/api/account/password/forgot/route.ts` — bucket consumption inserted between email normalization and `issueResetToken()`. Raw emails are hashed (`crypto.createHash("sha256")`) before being passed as the rate-limit identifier so Redis keys never contain the plaintext address.
- `tests/ratelimit.test.ts` (new) — 3 tests, Redis-gated.
- `task.md` §1.5 rate-limit catalog updated with the new bucket.
