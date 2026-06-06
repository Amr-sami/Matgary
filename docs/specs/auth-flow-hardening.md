# Auth & Onboarding Flow — Hardening Spec

Owner: Amr · Drafted: 2026-06-07

Companion to `i18n-bilingual.md`. Catalogues the 30 findings from the
post-i18n audit of signup, login, forgot/reset password, onboarding, and
the middleware gates. Each item is rated, the cheap ones are batched into
this iteration, the rest are queued.

## Severity rubric

- **🔴 Critical** — security boundary or data correctness; must fix.
- **🟠 Bug** — broken or fragile user-visible flow.
- **🟡 UX / inconsistency** — works but confusing or surprising.
- **🟢 Process / hygiene** — small or aesthetic.

## Items (audit cross-ref)

| # | Title | Sev | File / line | Phase |
| --- | --- | --- | --- | --- |
| 1 | Open redirect on login `next` | 🔴 | `login/page.tsx:38,117` | 1 |
| 2 | Reset email link has no locale prefix | 🔴 | `password/forgot/route.ts:75` | 2 |
| 3 | Reset email body + subject hardcoded AR | 🔴 | `password/forgot/route.ts:78-88` | 2 |
| 4 | Server action errors hardcoded AR | 🔴 | `actions.ts:37-49,70,103,120,249,258` | 1 |
| 5 | Signup auto-`signIn` failure silently → "ok" | 🟠 | `actions.ts:189-193` | 1 |
| 6 | Onboarding `refreshSession()` failure → dead button | 🟠 | `onboarding/page.tsx:45-47` | 1 |
| 7 | Signup Next button doesn't block on `invalid` email | 🟠 | `signup/page.tsx:210` | 1 |
| 8 | Email check fires on minimally-valid strings | 🟢 | `signup/page.tsx:78` | 3 |
| 9 | Reset token validated only at POST | 🟡 | `reset-password/page.tsx` | 3 |
| 10 | Reset success auto-navigates in 2s | 🟡 | `reset-password/page.tsx:65` | 3 |
| 11 | Onboarding re-asks shop name (already at signup) | 🟠 | `onboarding/page.tsx:78-84` | 1 |
| 12 | Step-3 "tips" rendered as fake links (`<span>`) | 🟠 | `onboarding/page.tsx:170-176` | 1 |
| 13 | Step-3 tips contradict `blank` preset | 🟠 | `dictionaries/*.json` | 1 |
| 14 | TOTP enforced only in 2fa-needed precheck? | 🔴→✅ | `lib/auth.ts:303-331` — **verified server-side enforcement** | — |
| 15 | Login Back button leaves stale `emailValue`/`passwordValue` | 🟠 | `login/page.tsx:185-189` | 1 |
| 16 | `void locale` dead code in onboarding | 🟢 | `onboarding/page.tsx:53` | 1 |
| 17 | Login shows password field before validating email | 🟡 | `login/page.tsx` | (defer, security trade-off) |
| 18 | Forgot-password success doesn't echo the email | 🟡 | `forgot-password/page.tsx:47-55` | 1 |
| 19 | Signup rate-limit msg Arabic + no wait hint | 🟠 | `actions.ts:70` | 1 (bundled w/ #4) |
| 20 | Handle hint shows invalid string in example | 🟡 | `signup/page.tsx:264` | 1 |
| 21 | Login Suspense fallback is bare "…" | 🟢 | `login/page.tsx:21-26` | 3 |
| 22 | Onboarding phone no validation | 🟡 | `onboarding/page.tsx:85-91` | 3 |
| 23 | Step-3 tips inconsistent link/no-link mix | 🟡 | `dictionaries/*.json` | 1 (bundled w/ #12,#13) |
| 24 | Wizard has no time / step-3 = confirm hint | 🟡 | `onboarding/page.tsx` | 3 |
| 25 | EN headlines use Arabic display fonts | 🟡 | `app/layout.tsx` | 3 |
| 26 | Login `next` drops query string in middleware | 🟢 | `middleware.ts:208` | 1 |
| 27 | Inconsistent locale prefix in post-auth nav | 🟢 | various | (covered by 1 + 11) |
| 28 | No CAPTCHA on signup / forgot | 🟢 | (rate-limited) | (post-launch) |
| 29 | No email verification | 🟠 | (signup creates tenant) | (post-launch, big) |
| 30 | Action `auth()` comment improvement | 🟢 | `actions.ts:247` | 1 (comment-only) |

## Phase plan

### Phase 1 — this iteration (single bundle)

The smallest set that addresses every 🔴 and 🟠 that doesn't need a
schema change or product decision. Roughly 6 surfaces:

1. **Security**: #1 (open redirect) — sanitize `next` to a relative path.
2. **Server error localization**: #4, #19 — actions return error
   **codes** (e.g. `EMAIL_TAKEN`, `RATE_LIMITED`), client maps codes to
   dictionary strings. No more Arabic literals in action returns.
3. **Signup robustness**: #5 (surface auto-login failure as a returned
   code), #7 (Next disabled on `invalid`), #20 (reset handle example
   when invalid).
4. **Login robustness**: #15 (Back button clears cached vals), #26
   (middleware preserves query string in `next`).
5. **Onboarding**: #6 (refresh failure → still navigate; middleware
   catches if needed), #11 (pre-fill shopName from `tenants.name`), #12
   + #13 + #23 (step-3 tips become real Links and branch per preset),
   #16 (drop dead `void locale`), #30 (comment cleanup).
6. **Forgot password**: #18 (echo the email in success state).

### Phase 2 — next iteration (needs design)

- #2 + #3 (locale-aware reset email). Smallest viable path:
  add `users.locale` column (`ar` | `en`), set it from the request
  locale at signup, read it in the forgot-password route to pick both
  the link locale prefix AND the email template.
- #9, #10 (reset password UX polish: pre-validate token, confirm-then-
  navigate instead of 2s timer).

### Phase 3 — backlog (small or product calls)

- #8 stricter email pre-check throttle.
- #17 "no account?" hint at login — needs security review.
- #21 better Suspense fallback.
- #22 Egyptian phone validation in onboarding.
- #24 wizard step semantics indicator.
- #25 Latin display font for EN.
- #28 CAPTCHA on signup / forgot.
- #29 email verification before tenant creation.

## Phase 1 — solution drivers

### Error-code contract (drives #4, #5, #19)

Replace string returns with discriminated codes:

```ts
type ActionError =
  | { code: "BAD_EMAIL_FORMAT" }
  | { code: "WEAK_PASSWORD" }
  | { code: "STORE_NAME_REQUIRED" }
  | { code: "HANDLE_INVALID" }
  | { code: "HANDLE_TAKEN" }
  | { code: "EMAIL_TAKEN" }
  | { code: "RATE_LIMITED" }
  | { code: "AUTO_LOGIN_FAILED" }  // new — covers #5
  | { code: "INTERNAL" };
type ActionResult<T = void> =
  | ({ ok: true } & T)
  | { ok: false; error: ActionError; field?: string };
```

Client `commonErrorMessage(code, dict)` switch maps to dictionary
strings. Existing dictionary keys (`auth.signup.errors.*`,
`auth.signup.emailTaken`, etc.) cover most; add a couple for the new
codes.

### Open-redirect sanitizer (drives #1)

Single tiny helper, used wherever a `next` URL comes from user input:

```ts
// Accept only same-origin, relative URLs. Reject schemes, protocol-
// relative (//evil), and absolute paths that start with backslash.
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}
```

Used in `login/page.tsx` (read of `?next=`) and could later be used in
middleware for consistency.

### Onboarding pre-fill (drives #11)

Onboarding page server-loads the tenant's current shop info:

```ts
// app/[lang]/(auth)/onboarding/page.tsx becomes a server wrapper around
// a client OnboardingContent that takes initial values as props.
```

We already moved marketing pages to that pattern; same here.

### Step-3 tips (drives #12, #13, #23)

Replace the `tips: [{ before, link, after }, …]` shape with two arrays
keyed by preset:

```json
"step3": {
  "tips": {
    "cornerstore": ["..."],
    "blank": ["..."]
  }
}
```

Wrap the colored token in a real `<Link>` to the relevant page. Since
the logged-in app stays Arabic-only for now, the links target
unprefixed routes (`/inventory/new`, `/sales`, `/settings`).

## Acceptance

1. `/ar/login?next=https://evil.com` redirects to `/` after login — not
   to `evil.com`.
2. On `/en/signup`, every server-side error message shows in English.
3. If `signIn` fails inside `signupAction`, the page shows
   "We created your account but couldn't sign you in — please log in"
   (localized) and a button linking to `/{locale}/login`.
4. Onboarding step 1 shows the shop name the user typed at signup,
   pre-filled and editable.
5. Onboarding step 3 tips:
   - `cornerstore`: link to Inventory + Sales + Settings/WhatsApp.
   - `blank`: link to Settings/Categories + Inventory + Sales.
   - Tokens render as actual clickable `<Link>`.
6. Forgot password success message echoes the email back to the user.
7. Login `?next=/reports?from=yesterday` → returns to `/reports?from=
   yesterday` after sign-in.
8. Login Back-from-2FA clears `emailValue` / `passwordValue` so a
   subsequent email change isn't ignored.
9. No regression on existing signup → onboarding → home flow.

## Implementation order

This iteration's commits, in order:

1. Spec doc (this file).
2. **Security + open redirect** — `safeNext` helper + login fix.
3. **Server error codes** — refactor `actions.ts` returns; map in
   signup page; add 1-2 new dictionary keys.
4. **Onboarding refactor** — split into server page + client content,
   pre-fill, tips per preset, real Links, refresh-failure tolerance.
5. **Login + forgot-password polish** — Back-button cleanup, success
   email echo, middleware `next` keeps query.

Each is small and independently revertable.
