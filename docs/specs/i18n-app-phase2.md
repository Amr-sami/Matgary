# i18n Phase 2 — Logged-in App (Arabic + English)

Owner: Amr · Drafted: 2026-06-07
Companion to `i18n-bilingual.md` (Phase 1: pre-login surface, shipped).

---

## 1. Goal

Translate the entire logged-in app into English so users who signed up
in English (or who later switch in settings) see the app in their
language. Arabic stays the default.

Locale is a **per-user preference**, not a URL prefix — different
model from Phase 1.

---

## 2. Scope

### In scope

Everything a user sees AFTER login:
- App shell: sidebar, top bar, user menu, notifications drawer,
  mobile bottom nav.
- Operations: dashboard, insights, sales/POS, cart, customer ledger.
- Catalog: products, categories, brands, attributes, inventory,
  CSV import.
- Money: purchases, suppliers, expenses, billing.
- People: team, attendance, leave, payroll.
- Settings (all tabs), including a new **Language** preference UI.
- Account: /account/change-password, /account/security,
  /account/delete.
- WhatsApp: inbox, threads, templates, connection.
- Shared UI: modals, toasts, errors, empty states.
- RTL ⇄ LTR flip (mirroring Phase 1 — logical Tailwind classes
  already in use, dir attribute drives the rest).

### Out of scope

- **User-entered data** (product names, customer names, supplier
  names, branch names, receipt custom blocks). These stay in
  whatever script the user typed them in; we render with
  `dir="auto"` so the browser picks the direction per string.
- Receipt templates already have a `receipt_language` setting per
  shop — independent of UI locale. No change.
- WhatsApp message templates are authored + Meta-approved per
  template. Out of UI-translation scope.
- The Phase-1 pre-login surface — already done, no rework.
- Logged-in app font swap (Tajawal → Inter for Latin) — deferred to
  brand pass; existing Latin subset on Cairo/Tajawal/Lemonada is
  good enough until then.

---

## 3. Approach

### 3.1 Routing — keep logged-in URLs unprefixed

Phase 1 put pre-login under `app/[lang]/...` because those URLs are
**public, shareable, SEO-relevant**. The logged-in app is **private
per-user resource navigation** — `/dashboard` is yours, `/sales` is
yours, the locale is a personal preference, not part of the address.

**Decision**: Keep logged-in routes flat (`/dashboard`, `/sales`,
`/inventory`, `/settings`, ...). Locale is read from the user's JWT
claim, not from the URL.

Trade-offs:
- ✅ Existing bookmarks + deep links keep working — no breaking
  change for any logged-in user.
- ✅ Matches Stripe, Linear, Vercel dashboard, etc. — the standard
  SaaS pattern.
- ❌ Slight inconsistency with the pre-login `/[lang]/...` pattern
  — but the two surfaces have different semantics, so the
  inconsistency is justified.
- ❌ Can't deep-link to "/dashboard in English" without first
  switching the user's preference — acceptable.

### 3.2 Locale source — `users.locale` → JWT → session → React

Already shipped (F-01): `users.locale` column exists, set at signup
from the `x-locale` request header.

Need to add:

1. **JWT claim**: extend `lib/auth.config.ts` session callback +
   `lib/auth.ts` jwt callback to surface `session.user.locale`.
   Add `locale` to the cached `resolveTenantContext` shape so it
   refreshes on the same cache-bust path as the other claims.
2. **Root layout** (`app/layout.tsx`) reads
   `session.user.locale` server-side and sets
   `<html lang dir>` from it (today it reads `x-locale` header).
   When no session (pre-login), keep the existing header path.
3. **DictionaryProvider** wraps the logged-in tree (new layout —
   see §3.4). Children call `useDictionary()` / `useLocale()` —
   same hooks the pre-login surface already uses.

### 3.3 Settings UI — change language

Add a new section under `/settings` (likely a tab next to "General"):
- Radio: العربية / English.
- Description: "اللغة المعروضة في كل أجزاء التطبيق."
- Save button → `PATCH /api/account/locale` → updates
  `users.locale` + busts user-context cache + bumps `token_version`
  (so other live sessions also see the new locale on their next
  request).
- After save success, **`window.location.reload()`** so RSC server
  components re-fetch with the new locale + `<html dir lang>`
  re-render. No partial-reload weirdness.

### 3.4 Where the provider lives

Today's logged-in tree:
```
app/
  layout.tsx               (root — html/body, SessionProvider, IconProvider)
  dashboard/page.tsx
  sales/page.tsx
  inventory/page.tsx
  ...
  settings/page.tsx
  (app)/layout.tsx?        ← does this exist?
```

Most logged-in pages share an `AppShell` component (`components/
layout/AppShell.tsx`) that renders the sidebar + user menu. AppShell
is mounted per-page (each page wraps itself in AppShell). That's
where the DictionaryProvider goes — wrap AppShell's children:

```tsx
// components/layout/AppShell.tsx
import { DictionaryProvider } from "@/components/i18n/DictionaryProvider";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { auth } from "@/lib/auth";

export async function AppShell({ children }) {
  const session = await auth();
  const locale = (session?.user?.locale ?? "ar") as Locale;
  const dict = await getDictionary(locale);
  return (
    <DictionaryProvider locale={locale} dict={dict}>
      {/* sidebar / topbar / children */}
    </DictionaryProvider>
  );
}
```

This is also the place to plant the in-app **locale switcher** —
goes in the user menu (top-right). Click → opens a small popover
with the two locale options → click an option → calls the same
PATCH endpoint + reload.

### 3.5 Formatters (`lib/i18n/format.ts` — new)

Centralize:

```ts
formatCurrency(amount, locale)
formatNumber(n, locale)
formatDate(date, locale, opts?)
formatTime(date, locale)
formatRelative(date, locale)
formatPercent(n, locale)
```

Built on `Intl.NumberFormat` / `Intl.DateTimeFormat` with our locale
strings (`ar-EG`, `en-EG` or `en-US`).

**Number system decision** (Phase 2 cross-cutting):
The pre-login surface already uses Latin digits for prices in the
pricing card (forced via `dir="ltr"` on the number). In the
logged-in app, the existing Arabic UI mixes Arabic-Indic and Latin
digits inconsistently (CustomersMock uses Arabic-Indic; receipts
use Arabic-Indic; insights probably Latin).

**Proposal**: always Latin digits in money + counts + dates in BOTH
locales. Rationale: scanability in a POS context. Arabic-Indic is
reserved for narrative copy ("منذ ٣ أيام") if at all.

This is a one-line `Intl.NumberFormat` option:
```ts
new Intl.NumberFormat(locale, { useGrouping: true, numberingSystem: "latn" })
```

To be confirmed by Amr before Phase 2.5 (Operations) ships.

**Currency**:
- AR locale: `2,300 ج.م` (or `٢٬٣٠٠ ج.م` if we go Arabic-Indic).
- EN locale: `EGP 2,300` (or `2,300 EGP` — confirm).

**Date**:
- AR: `٢ مايو ٢٠٢٦` (or Gregorian Latin `2 مايو 2026`).
- EN: `2 May 2026` (or `May 2, 2026` — confirm).

### 3.6 RTL ⇄ LTR

No new work needed at the layout level. Phase 1 already:
- Drops `direction: rtl` from `globals.css` (the dir attribute
  drives now).
- Replaces `text-align: right` with `text-align: start`.
- Logical Tailwind utilities (`ms-`/`me-`/`ps-`/`pe-`/`start-`/`end-`)
  used everywhere.

The logged-in app inherits all of that. Each surface PR's job is to
**audit for hardcoded `text-right`, `text-left`, `right-*`,
`left-*`, `ml-*`, `mr-*`** and convert to logical equivalents where
they're meant to flip with direction.

Grep target (recorded as a Phase-2 hygiene task):
```
grep -rln 'text-right\|text-left\|\bml-[0-9]\|\bmr-[0-9]\|\bpl-[0-9]\|\bpr-[0-9]\|\bright-[0-9]\|\bleft-[0-9]' \
  components/ app/ --include='*.tsx'
```

Each hit is reviewed: convert to logical OR keep physical (e.g.,
number columns that should always right-align regardless of dir →
keep `text-end` not `text-right`; logo positioning that's truly
physical-anchored → keep).

### 3.7 Data-content rendering

User-entered values (product names, customer names, branch names,
shop names, custom receipt blocks, notes) MUST render with
`dir="auto"` so the browser picks the direction per-string:

```tsx
<span dir="auto">{product.name}</span>
```

This is the only way a single page can render mixed-script content
correctly (a customer's Arabic name next to a product with an
English name).

A `<UserText>` shared component would centralize it — proposed in
Phase 1 (Foundation).

---

## 4. Cross-cutting decisions

All locked after Amr review on 2026-06-07.

| Decision | Value | Rationale |
| --- | --- | --- |
| Routing model | Unprefixed (locale via JWT) | Bookmarks survive |
| URL change for existing users | None | No breakage |
| Number system | **Latin digits in both locales** | SaaS norm (Stripe, Linear, Vercel); scanability in POS |
| Currency placement (AR) | `2,300 ج.م` | Existing convention; symbol after the number is standard in Egypt |
| Currency placement (EN) | `EGP 2,300` | `Intl.NumberFormat(en-EG, {style:"currency", currency:"EGP"})` default; symbol-before for EN |
| Decimal handling | Two decimals when fractional, none when whole (`2,300` not `2,300.00`) | Cleaner POS scanning |
| Date format (AR) | `2 مايو 2026` (Gregorian + Arabic month + Latin digits) | Latin digits per the number-system call above |
| Date format (EN) | `2 May 2026` (day-first) | Egypt is day-first locale; matches user mental model |
| Time format | `14:35` (24h, both locales) | Standard in Egypt for both languages |
| Relative time | `Intl.RelativeTimeFormat` per locale | "3 days ago" / "منذ 3 أيام" |
| Fonts | Cairo/Tajawal/Lemonada with Latin subset | Revisit at brand pass |
| User-entered text direction | `dir="auto"` via `<UserText>` | Browser picks per string |
| Receipt language | Existing per-shop setting, independent of UI | Don't tangle two locale axes |
| WhatsApp templates | Author-controlled, per-template language code | Out of UI-i18n scope |
| Locale switch UX | Save → `window.location.reload()` | Forces RSC re-render with new dict |
| JWT refresh on switch | Yes, plus `token_version` bump | Other sessions pick it up |
| Sign out other sessions on language change | No | Preference, not security event |
| Language tab location | Own tab in `/settings` | Per Amr |
| In-shell locale switcher placement | User menu only (no top-bar globe) | Per Amr; keeps top bar clean |
| Per-phase spec docs | Created when each phase starts | This file stays the master index |

---

## 5. Phase plan — 6 sub-specs

Six phases, sequenced. Each builds on the previous. Each phase
ships its own commit + dev-server smoke. The order maximizes
shippable value early.

### Phase 2.1 — Foundation (one PR, blocks everything else)

**Surfaces**:
- `lib/auth.config.ts` + `lib/auth.ts`: add `locale` claim to JWT +
  session.
- `lib/auth.ts:resolveTenantContext`: include `users.locale`.
- `app/layout.tsx`: read locale from session (fallback to header
  for unauth).
- `components/layout/AppShell.tsx`: wrap in DictionaryProvider.
- `components/layout/UserMenu.tsx`: add globe icon + popover with
  the two locale options.
- `app/api/account/locale/route.ts` (new): `PATCH` endpoint to
  update `users.locale` + bust cache + bump tokenVersion.
- `lib/i18n/format.ts` (new): centralized formatters.
- `components/ui/UserText.tsx` (new): `dir="auto"` text wrapper.
- New dictionary namespace: `app.common` (shared strings used
  everywhere — "Save", "Cancel", "Loading", "Error", "Confirm",
  "Yes/No", "Search", "Filter", "Add", "Edit", "Delete", "Print",
  "Export", "Close", "Back", etc.).
- New dictionary namespace: `app.shell` (sidebar, top bar, user
  menu, search bar, notifications drawer headings, mobile bottom
  nav labels).
- `components/layout/Sidebar.tsx`: all link labels via dictionary.
- `components/layout/MobileBottomNav.tsx`: same.
- `components/layout/UserMenu.tsx`: all menu items.
- `components/notifications/*`: drawer header + empty state.

**Estimated strings**: ~120 (common + shell).

**Acceptance**:
- Switch language from user menu → page reloads → entire shell is
  in the new locale.
- HTML `<html lang dir>` flips.
- All sidebar / top-bar / user-menu strings localize.
- No hard refresh needed beyond the post-save reload.
- A user who signed up in English sees the shell in English on
  first login.

### Phase 2.2 — Operations (high-traffic)

**Surfaces** (in order of user impact):
- `/dashboard` + `/insights` — KPI cards, charts, filters, date
  range.
- `/sales` — sales list, filters, hour heatmap, sales chart.
- `/sales/cart` — POS UI (product search, scanner, cart, totals,
  discounts, customer picker, payment method).
- `/sales/[id]` — sale detail, receipt rendering on screen + print
  preview.
- `/customers` + `/customers/by-phone/[phone]` — customer list +
  ledger view + wallet history.
- `components/sales/Receipt.tsx`,
  `components/sales/InvoiceReceipt.tsx` — labels (not the receipt
  CONTENT which is per-shop language).
- `components/sales/PrintOptionsModal.tsx` + related.

**Estimated strings**: ~250.

**Acceptance**:
- A cashier opens POS in English → every label is English, prices
  in Latin digits, "Add to cart" / "Total" / "Cash" / "On account".
- Customer ledger renders in EN with English column headers,
  Arabic-named customer's name in `dir="auto"`.
- Receipt preview labels in user's locale; receipt CONTENT still
  follows the shop's `receipt_language` setting.

### Phase 2.3 — Catalog

**Surfaces**:
- `/inventory` + `/inventory/new` + `/inventory/[id]` — list,
  filters, sort menu, bulk actions bar, add-product wizard (3
  steps).
- `/inventory/import` — CSV import UI (preview + commit, error
  rows).
- `/settings/categories`, `/settings/brands`,
  `/settings/attributes` — management tabs.

**Estimated strings**: ~180.

**Acceptance**:
- Add-product wizard works end-to-end in EN.
- CSV import preview surface (column names, error per row) is
  localized.
- Sort menu / filter chips in user's locale.

### Phase 2.4 — Money & people

**Surfaces**:
- `/purchases` (the uncommitted purchases page + new components),
  `/purchases/[id]`, payment modal, payment history.
- `/suppliers` + `/suppliers/[id]`.
- `/expenses` + recurring expense scheduler UI.
- `/team` — staff list, add staff form, permission editor,
  compensation editor.
- `/attendance` — staff check-in roster, geofences settings.
- `/leave` — request list + decision flow.
- `/payroll` — period view, export.

**Estimated strings**: ~300. (HR / team is wide.)

**Acceptance**:
- An owner can manage staff, attendance, leave, payroll in EN
  with no Arabic leakage.
- Purchase-order flow (create → receive → payment) localized.
- Currency / dates use the formatters from Phase 2.1.

### Phase 2.5 — Settings & account

**Surfaces**:
- `/settings` (all tabs): shop info, branches, receipt designer,
  WhatsApp connection, billing, **Language** (planted in 2.1 but
  copy reviewed here).
- `/account/change-password` (already partly i18n'd from the
  hardening work — finish if any gaps).
- `/account/security` (2FA setup wizard, recovery codes display,
  active sessions list, sign-out-everywhere button).
- `/account/delete` (account deletion confirmation flow).

**Estimated strings**: ~250 (settings is wide; receipt designer
alone is a big surface).

**Acceptance**:
- Settings is fully translated. The Language tab itself is
  localized in both locales (chicken/egg solved — translation
  is done first).
- 2FA setup wizard text + QR caption + recovery codes display
  bilingual.
- Account deletion warning + 30-day grace explanation in user's
  locale.

### Phase 2.6 — WhatsApp + misc + shared

**Surfaces**:
- `/whatsapp` — inbox, conversation threads, message composer.
- `/whatsapp/templates` — template list, create/edit.
- `/tasks` — board, task form modal.
- `/notifications` (drawer + page).
- `/activity` — activity log table.
- Shared components: `components/ui/Modal.tsx` (close button label
  + ARIA), generic confirm/delete modals, toasts (`components/feedback/*`),
  error screens (`components/feedback/ErrorScreen.tsx`),
  empty-state components.

**Estimated strings**: ~200.

**Acceptance**:
- WhatsApp inbox works in EN (note: the messages themselves stay
  in whatever language the customer wrote — `dir="auto"`).
- All modals + toasts + error screens localized — no hardcoded
  Arabic strings remain in shared components.
- Activity log column headers + action labels localized; the
  activity strings themselves (e.g. action category labels) come
  from `lib/activity-labels.ts` which gets a parallel EN map.

---

## 6. String extraction strategy

Same approach Phase 1 used:

1. Add to `dictionaries/ar.json` and `dictionaries/en.json` under a
   new top-level `app` namespace.
2. Sub-namespaces per phase: `app.shell`, `app.dashboard`,
   `app.sales`, `app.inventory`, `app.purchases`, `app.team`,
   `app.attendance`, `app.leave`, `app.payroll`, `app.settings`,
   `app.account`, `app.whatsapp`, `app.tasks`, `app.activity`,
   `app.common`, `app.errors`, `app.modals`.
3. Component pattern:
   ```tsx
   const { app } = useDictionary();
   <h1>{app.dashboard.title}</h1>
   ```
4. Server components that need strings outside the
   DictionaryProvider use `getDictionary(locale)` directly — same
   pattern as Phase 1.

**Source of truth for the AR side**: existing in-file Arabic
strings. Each phase's PR does the lift-and-shift, no semantic
rewording (preserve the owner's voice).

**English drafting**: I draft, you review per phase, ship.

---

## 7. Migration / rollout

- **No URL changes**, so no redirect strategy needed.
- Database migration: add `locale` to JWT in lib/auth.ts (already
  available in `users.locale` post-F-01). One PR's worth of plumbing
  in Phase 2.1.
- Live rollout: phases ship sequentially. Until a given phase ships,
  its surface stays Arabic-only for English users too — gracefully
  degraded, not broken.
- The Language tab in settings can be enabled as soon as Phase 2.1
  lands (shell is translated). Users who switch to English BEFORE
  later phases ship will see English shell + Arabic operational
  surfaces. Acceptable, but document in the release notes.

**Recommended release pacing**:
- Phase 2.1: ships standalone (foundation).
- Phase 2.2 + 2.3 + 2.4 + 2.5: each its own PR, shippable
  independently in any order.
- Phase 2.6: last (shared UI / error screens — touches many
  components but doesn't add new screens).

---

## 8. Acceptance criteria (whole Phase 2)

When all six sub-phases ship:

1. A user signs up at `/en/signup` → `users.locale = 'en'` → on
   first login they see the entire app in English.
2. A user signs up at `/ar/signup` → `users.locale = 'ar'` → entire
   app in Arabic.
3. A user changes language from `/settings` → full reload → app is
   in the new language; `<html dir>` flips correctly.
4. Two sessions on different devices: changing language on device A
   propagates to device B on its next navigation (via JWT
   tokenVersion + cache bust). No security event = no forced
   sign-out.
5. Receipts continue to render in the SHOP's configured language
   regardless of UI locale (existing feature preserved).
6. WhatsApp conversation messages render `dir="auto"` so mixed-
   script threads (customer wrote Arabic, business sent English)
   read naturally.
7. Latin digits used in all money / counts / dates in both locales
   (default per §4).
8. No hardcoded Arabic strings remain in any logged-in component
   (CI grep check).
9. RTL ⇄ LTR flips visually clean — sidebar mirrors, modal close
   button stays in the right corner regardless of direction
   (logical `end-`), no horizontal scroll, no overlapping elements.

---

## 9. Out-of-scope / Phase 3+

Track separately:

- **Latin display font** (Inter/Sora) for EN headlines — brand pass.
- **Localized SEO** / Open Graph for the logged-in app — irrelevant
  (private).
- **Hijri calendar option** — out of scope until requested.
- **Arabic-Indic digit OPT-IN** for users who prefer them —
  defaults to Latin per §4; add a setting toggle later if asked.
- **Right-to-left charting** (e.g., should bar charts in AR mirror
  axis order?) — punt; modern users read time-series left→right
  regardless of script.
- **Receipt CONTENT localization** beyond the existing
  `receipt_language` setting — out of scope.
- **Localized currency symbols** other than EGP — multi-currency is
  a separate feature.

---

## 10. Decisions locked (2026-06-07)

| # | Question | Resolution |
| --- | --- | --- |
| 1 | Number system | Latin digits everywhere (en + ar) |
| 2 | EN currency | `EGP 2,300` |
| 3 | EN date | `2 May 2026` (day-first) |
| 4 | AR date | `2 مايو 2026` (Gregorian + Arabic month + Latin digits) |
| 5 | Phase order | 2.1 → 2.2 (Operations) → 2.5 (Settings, so Language tab is native) → 2.3 → 2.4 → 2.6 |
| 6 | Language tab placement | Own tab in `/settings` |
| 7 | Locale switcher placement | User menu only (no top-bar globe) |
| 8 | Per-phase docs | Created at the start of each phase. This file stays the master index. |

All other defaults per §4 follow SaaS convention. No outstanding
questions.

---

## 11. Ready to start

Phase 2.1 (Foundation) is the next deliverable. Touches:

- `lib/auth.config.ts`, `lib/auth.ts` — JWT `locale` claim
- `app/layout.tsx` — read locale from session
- `components/layout/AppShell.tsx` — wrap in `DictionaryProvider`
- `components/layout/UserMenu.tsx` — globe + popover + locale switcher
- `app/api/account/locale/route.ts` — new PATCH endpoint
- `lib/i18n/format.ts` — formatters (currency / date / number / relative)
- `components/ui/UserText.tsx` — `dir="auto"` wrapper
- `dictionaries/{ar,en}.json` — add `app.common` + `app.shell` namespaces
- `components/layout/Sidebar.tsx`, `MobileBottomNav.tsx`,
  `components/notifications/*` — wire labels via dictionary

Estimated: ~120 strings, 1 new API route, 1 new endpoint, ~2 hours
of implementation + smoke + commit.

Say **go** to start Phase 2.1.
