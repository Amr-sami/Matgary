# H09 — Session revocation ("sign out everywhere")

> Source: `task.md` §7.1 H9

- **Status:** pending
- **Effort estimate:** 1-2 hrs
- **Depends on:** H03 (this is the recovery action after 2FA enable / compromise)

## Why

Today a leaked JWT is valid until expiry — no server-side way to invalidate. After H03 lands, owners will expect this control (and a pen-tester will ask for it). Implement via a token-version column carried in the JWT and checked on every session resolve.

## Acceptance criteria

- [ ] Migration adds `users.token_version int not null default 0`.
- [ ] JWT callback writes `tv` claim from `users.token_version` at issue time.
- [ ] Session callback rejects (returns null session) if `tv` !== current `users.token_version` for that user.
- [ ] `/account/security` exposes "Sign out everywhere" button. Action: increment `users.token_version`, bust user-context cache via `bustUserContextCache(userId)`.
- [ ] On 2FA enable (H03), `token_version` is bumped automatically — forces a re-login on any other device that was logged in when 2FA went on.
- [ ] On password change (`pwd.change` flow), `token_version` is bumped — same reason.
- [ ] Activity log: `account.session_revoke_all`.
- [ ] Test: with a JWT issued at `tv=0`, bump `tv` to 1 on the DB, next request returns 401. Re-login issues `tv=1` token, works.

## Implementation plan

1. Schema edit + migration.
2. `lib/auth.ts`:
   - `authorize` returns `tokenVersion` in the user object.
   - `jwt` callback copies `tokenVersion` from user (initial sign-in) or refreshes from DB on `update` triggers.
   - `session` callback: re-read `users.token_version` (with the user-context cache it's cheap), compare to `token.tv`. Mismatch → return null.
3. `/api/account/sessions/revoke-all` route handler. Owner-or-self only (no cross-user revoke for staff in v1).
4. UI: button in `/account/security` with confirm dialog. On success, sign the current session out too (re-login required).
5. Wire `token_version` bump into existing password-change and new 2FA-enable flows.

## Out of scope

- Per-device session list ("active sessions").
- Selective revoke (revoke this device only).
- Session inactivity timeout.

## Risks & gotchas

- The session callback runs on every request. Caching `users.token_version` for 60s (via the existing user-context cache) means a revoke can take up to 60s to bite — document this as the trade-off. Acceptable for v1.
- Bumping `token_version` on password change is a behaviour change — current users will be logged out everywhere on their next password change. Worth a banner the first time.

## Verification log

(populated during execution)
