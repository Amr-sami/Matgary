# Bilingual (Arabic + English) — Spec

Owner: Amr · Drafted: 2026-06-06

## 1. Goal

Make the site bilingual: Arabic (default) and English. Phase 1 covers **only the
pre-login surface**. The logged-in app stays Arabic-only until Phase 2.

A globe icon in the navbar lets visitors switch language; the choice persists
across pages and reloads.

## 2. Scope

### In scope — Phase 1 (pre-login)

- Landing: `app/welcome/page.tsx` (hero, features, how-it-works, pricing, FAQ).
- Marketing pages: `about`, `blog`, `contact`, `help`, `privacy`, `terms`, `status`.
- Auth pages: `login`, `signup`, `forgot-password`, `reset-password`.
- Onboarding (post-signup, still pre-app): `onboarding`.
- Shared shells: marketing layout, auth layout (the 60/40 split + showcase
  panel headline), root `<html lang>` / `<head>` metadata.
- Shared components: `LandingNavbar`, `LandingFooter`, the auth-layout
  showcase, button/CTAs, form labels and validation strings on the above pages.
- Locale switcher UI (globe icon, persists choice).

### Out of scope — Phase 1

- Logged-in app routes (`/dashboard`, `/sales`, `/purchases`, `/inventory`,
  `/settings`, etc.) — these remain Arabic-only.
- DB content (product names, customer names, receipt label overrides) — these
  are user-entered and out of i18n.
- Server-emitted strings: receipt PDFs, WhatsApp templates, email/SMS, error
  responses from API routes.
- Number / currency / date formatting (Phase 1 keeps the existing Arabic
  format everywhere; revisit in Phase 2).
- Persisting locale per-user in DB (cookie is enough for Phase 1).

## 3. Approach

**Vanilla Next.js 16 i18n** following the official guide at
`node_modules/next/dist/docs/01-app/02-guides/internationalization.md`.

No 3rd-party library in Phase 1. Reasons:

- The Next 16 docs prescribe a concrete pattern (dictionaries + `proxy.ts` +
  `app/[lang]/...`) — predictable, no library compat risk.
- Pre-login strings are mostly static; we don't need ICU MessageFormat,
  pluralisation, or rich format helpers yet.
- We can adopt `next-intl` in Phase 2 if the logged-in app needs richer
  formatting; the dictionary JSONs port over cleanly.

### 3.1 Locale routing

- Locales: `ar` (default), `en`.
- **Pre-login routes move under `app/[lang]/...`** — only those listed in §2.
- **Logged-in routes stay at their current paths** (unprefixed) and continue
  to render in Arabic.
- A new `proxy.ts` at repo root handles:
  - If the path matches a known pre-login slug without a locale prefix
    (`/welcome`, `/login`, `/about`, …), redirect to `/{detected}/welcome`
    using cookie → `Accept-Language` → default (`ar`).
  - If the path already has `/ar/...` or `/en/...`, pass through.
  - All other paths (logged-in app, API, `_next`, static) pass through
    unchanged.
- After successful login, redirect to the existing unprefixed route
  (`/dashboard`); inside the app, Arabic is forced.

### 3.2 File layout

```
app/
  layout.tsx                  ← root layout, becomes locale-aware
  [lang]/
    layout.tsx                ← sets <html lang> + <body dir> for pre-login
    welcome/page.tsx          ← moved from app/welcome
    (marketing)/...           ← moved from app/(marketing)
    (auth)/...                ← moved from app/(auth)
  (app)/...                   ← unchanged, Arabic-only logged-in surface
  api/...                     ← unchanged
dictionaries/
  ar.json                     ← keys grouped by surface (nav, hero, login, …)
  en.json
lib/i18n/
  config.ts                   ← locale list, default, type Locale
  get-dictionary.ts           ← server-only dynamic import per the Next docs
  use-locale.ts               ← client hook for the language switcher
proxy.ts                      ← locale detection + redirect
```

Note: Next 16 deprecates `middleware.ts` in favour of `proxy.ts`. The current
repo still uses `middleware.ts` (warning visible in dev). The migration is a
separate task; for now we add `proxy.ts` alongside or as part of that migration
— TBD when implementing.

### 3.3 Switcher UI

- Icon: Phosphor `Globe` (added to `lib/icons.ts` re-export).
- Placement:
  - Desktop navbar: between the section links and the auth CTAs (left of
    "تسجيل الدخول" in RTL / right of it in LTR). Compact: icon-only button
    with the current locale label (e.g. `🌐 EN` / `🌐 ع`) as text. Click
    opens a small popover with both options.
  - Mobile drawer: a row at the top of the drawer, before the section links.
  - Auth pages: a small variant placed in the top-end corner of the auth
    layout (so visitors can switch while signing in).
- Behaviour:
  - Click → write `NEXT_LOCALE` cookie (1 year, `Lax`, `Path=/`) and
    `router.replace()` to the same page under the new locale prefix.
  - The cookie drives the proxy's "no prefix → which locale?" decision on
    future visits.

### 3.4 RTL / LTR and typography

- Current root layout hardcodes `lang="ar" dir="rtl"`. After: the localized
  `app/[lang]/layout.tsx` sets these from the param; the un-localized root
  defaults to `ar` / `rtl` for the logged-in app.
- The whole codebase already uses logical Tailwind properties (`ms-`/`me-`,
  `ps-`/`pe-`, `start-`/`end-`) — these auto-flip with `dir`, so no class
  rewrites are needed.
- Fonts: existing `Cairo`, `Tajawal`, `Lemonada` all have `subsets: ["arabic"]`
  only. For English:
  - Add `"latin"` to each `subsets` array so the Arabic display fonts also
    render Latin glyphs acceptably (Cairo handles Latin well).
  - Reserve the option to add `Inter` (or similar) for English headlines if
    Tajawal/Lemonada look weak in Latin — decide visually after the first
    pass.
- `globals.css` currently sets `html { direction: rtl; }` and forces
  `text-align: right` on inputs (`app/globals.css:79-84`). Both need to
  switch to logical values (`text-align: start`) and to drop the hardcoded
  `direction` so the `<html dir>` attribute wins.

## 4. Phase 1 string inventory

Each grouping below becomes a key namespace in the dictionary JSONs.

- `common`: brand name, "loading", primary CTAs ("ابدأ مجاناً" / "Start free"),
  "تسجيل الدخول" / "Sign in", "السابق" / "Previous", error fallbacks.
- `nav`: section labels (`المميزات`, `كيف يعمل`, `الأسعار`), CTA labels, the
  mobile-drawer aria labels (open/close menu).
- `landing`: hero (headline + subheadline + CTA), features section, how-it-
  works, pricing tiers, FAQ.
- `footer`: column titles, link labels, copyright.
- `marketing`:
  - `about`, `contact`, `help`, `privacy`, `terms`, `status` — one sub-
    namespace each, with all body copy keyed.
  - `blog` index strings (the post body content is out of scope unless we
    want bilingual posts — flag as open question §7).
- `auth`:
  - `login`, `signup`, `forgot`, `reset`, `2fa`, `onboarding` — labels,
    placeholders, button text, success/error toasts, the auth-layout
    showcase headline ("انطلق بمتجرك للسماء").
  - Inline validation strings already in code (e.g. "أدخل بريداً إلكترونياً
    صحيحاً") move out of the components into the dictionary.
- `meta`: `<title>` and `<meta description>` for each pre-login page.

Translation source: I'll draft English from the Arabic and you review before
we ship the English JSON.

## 5. Acceptance criteria

1. Visiting `/welcome` with no cookie redirects to `/ar/welcome` (default).
2. Visiting `/welcome` with `NEXT_LOCALE=en` cookie redirects to `/en/welcome`.
3. Clicking the globe switcher on `/ar/welcome` lands on `/en/welcome` with
   matching content, `<html lang="en" dir="ltr">`, and the cookie updated.
4. All pre-login text from §4 reads from the dictionary — no Arabic string
   remains hardcoded in those files (lint check: grep for Arabic literals
   under `app/[lang]/...`).
5. RTL ⇄ LTR flips are visually clean: nav order mirrors, the auth 60/40
   split swaps sides, icons that had directional meaning (arrows) flip.
6. Logged-in routes (`/dashboard` etc.) are unaffected — they still render
   in Arabic with `dir="rtl"`.
7. After login, the user lands at `/dashboard` (no locale prefix) regardless
   of which locale they used to sign in.
8. Lighthouse / a11y: `<html lang>` matches the active locale; no mixed-
   direction layout warnings.

## 6. Implementation plan

Once the spec is approved, execute in this order. Each step is a commit.

1. **Scaffolding**: `lib/i18n/{config,get-dictionary}.ts`, empty
   `dictionaries/{ar,en}.json`, `Globe` re-export in `lib/icons.ts`. No
   behaviour change.
2. **Move pre-login routes** under `app/[lang]/...`. Confirm dev still
   renders Arabic at `/ar/welcome`, `/ar/login`, etc.
3. **Add `proxy.ts`** with locale detection + redirect. (Coordinate with the
   existing `middleware.ts` → `proxy.ts` migration warning.)
4. **Extract Arabic strings** into `dictionaries/ar.json`; wire each pre-
   login page/component to read from the dictionary. Still Arabic-only end-
   to-end at this point.
5. **Translate to English** → `dictionaries/en.json`; verify each page in
   the browser at `/en/...`.
6. **Locale switcher** (`LangSwitcher` component + Phosphor `Globe`), placed
   in navbar (desktop + mobile) and auth-layout top-end.
7. **Dynamic `<html lang>` / `dir`** in `app/[lang]/layout.tsx`; drop
   hardcoded `direction: rtl` from `globals.css` and switch the input
   `text-align` to `start`.
8. **Font subsets**: add `"latin"` to Cairo/Tajawal/Lemonada; visual sweep
   of the English screens.
9. **E2E smoke**: a Playwright test that loads `/en/welcome`, switches to
   AR, logs in, and confirms the dashboard renders.

## 7. Open questions for Amr

1. **Locale codes**: `ar` / `en`, or the regional `ar-EG` / `en-US`? My
   default is plain `ar` / `en` (shorter URLs, no SEO downside for an MVP).
2. **Blog**: do blog posts need bilingual bodies, or English-only frontmatter
   with Arabic bodies for now? Default: skip blog post bodies in Phase 1.
3. **English Tajawal vs Inter**: keep using the Arabic display fonts for
   English headlines, or add Inter as the Latin display font? Default: keep
   the same fonts; revisit if visually weak.
4. **Country/currency formatting**: Phase 1 keeps Arabic-Egypt formatting in
   both locales (EGP, Arabic numerals on receipts, etc.). Confirm?
5. **Onboarding pages**: should the welcome/onboarding flow already be
   bilingual in Phase 1, or only the strict auth screens? Default: include
   onboarding (it's still pre-app).
6. **Persist user choice in DB**: Phase 2, not now. Confirm?

---

# Phase 1.5 — Direction-handling fix

Drafted: 2026-06-06 (post-Phase-1 sweep)

## Symptom

On `/en/signup` the field placeholder "Happy Store" reads right-to-left and
the input box behaves as RTL even though the page is LTR. The same primitives
also force `dir="rtl"` on Arabic pages even when the caller intended the
field to follow the document direction.

## Root cause

Three form primitives hardcode a `dir=` attribute directly on the `<input>`
/ `<select>` element. The hardcoded value beats the document's
locale-driven `<html dir>`, so the field is locked to one direction
regardless of page locale.

| File | Line | Hardcoded value |
| --- | --- | --- |
| `components/ui/Input.tsx` | 22 | `dir="rtl"` |
| `components/ui/Select.tsx` | 29 | `dir="rtl"` |
| `components/ui/PasswordInput.tsx` | 34 | `dir="ltr"` |

Two additional Arabic-only strings live in component code on the pre-login
surface:

| File | Line | String |
| --- | --- | --- |
| `components/ui/PasswordInput.tsx` | 47-48 | `aria-label="إخفاء كلمة السر"` / `title="إخفاء"` (and the show variants) |
| `components/ui/Modal.tsx` | 59 | `aria-label="إغلاق"` (Modal isn't used on pre-login surface today, so deferred to Phase 2) |

## Audit summary

Wider grep: 111 occurrences of hardcoded `dir=` across ~40 files. Most are
intentional and **stay**:

- **Callers that pass `dir="ltr"`** on specific Latin fields (email, phone,
  store handle, the `@` prefix span in signup) — these are correct: the
  field semantically must read LTR regardless of page locale.
- **Currency / monospaced numbers** (`landing/Pricing.tsx`, `Stats.tsx`,
  `Features.tsx` ChatMock timestamp, etc.) lock specific spans to LTR so
  numbers render correctly — correct, leave alone.
- **Receipt rendering** (`globals.css` `direction:` rules under `@media
  print` and `.receipt-preview`) — receipts have their own forced
  direction, independent of UI locale. Leave alone.
- **Root layout's `<html dir={dir}>`** — this is the dynamic source of
  truth, must keep.

The only bugs are the three **defaults** baked into the form primitives.

## Fix plan

1. **Strip the hardcoded `dir=` from the three form primitives.** Each
   field then inherits the document's `<html dir>` by default. Callers that
   already pass `dir="ltr"` (email, phone, handle) keep working because
   `{...props}` is spread after, so an explicit prop still wins.
2. **Localize the password show/hide aria-label + title.** Add
   `common.showPassword` / `common.hidePassword` to ar.json + en.json; read
   via `useDictionary()`. Promote `PasswordInput` to a context consumer
   (it's already `"use client"`).
3. **No CSS changes.** Receipt rules stay. The `text-align: start` on
   `input, select, textarea` in `globals.css` is already correct.
4. **Defer Modal close button** to Phase 2 (logged-in surface).

## Acceptance criteria

1. `/en/signup` storeName placeholder "Happy Store" reads left-to-right.
2. `/ar/signup` storeName placeholder "متجر السعادة" reads right-to-left.
3. Eye/EyeOff toggle on password fields has aria-label in the active locale.
4. Fields that the caller explicitly forces to LTR (email, phone, handle)
   continue to render LTR in both locales — no regression.
5. No regression on welcome, marketing, auth pages, or receipt printing.

## Out of scope (Phase 2)

- `Modal.tsx` Arabic close label.
- `text-right` / `text-left` utility classes in 7 logged-in app files
  (CategoryPieChart, TopProducts, TrendChart, PrintOptionsModal,
  BranchPicker, ExpenseTable, app/purchases/page.tsx) — most are
  intentional alignment for number columns, but worth a pass when we
  i18nize the logged-in app.
- The 111 hardcoded `dir=` in logged-in components — same review.

