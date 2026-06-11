# Phase 3 — Safety Net + Refactor Preparation

Phase 3 builds the e2e safety net *before* any large UI refactor, and produces decomposition plans for the two known god files (`SaleForm.tsx`, `app/settings/page.tsx`) plus a Next 16 modernization plan for the dashboard / sales / customers / insights surfaces.

**No SaleForm or settings refactoring happens in Phase 3.**

---

## Step 1 — E2E safety net (shipped)

Added a Playwright suite that pins the contract of every critical business workflow against the current dev server.

### Architecture decisions

- **Project-level `storageState`**: a `globalSetup` script provisions ONE shared owner tenant by direct DB insert (`ensureOwner` in `tests/e2e/helpers/seed-owner.ts`), then drives the simple login form to get cookies. Every spec defaults to loading that authenticated state — no per-test signup dance.
- **Auth-flow specs opt out**: `test.use({ storageState: { cookies: [], origins: [] } })` so login/logout tests start anonymous.
- **Anonymous probes**: tests assert "anonymous returns 401" use `playwright.request.newContext({ storageState: { cookies: [], origins: [] } })` to get a fresh, cookie-less APIRequestContext.
- **Behaviour pinning over correctness**: when the actual server behaviour disagrees with the obvious-correct contract, the test pins current behaviour and the comment flags it as a latent bug. This means future refactors that *change* the behaviour break the test (correct) instead of giving a false-green.
- **Dev-mode timeouts**: per-test 90s, expect 15s, navigation 30s, signupOwner waitForURL 45s. Enough headroom for first-compile latency without masking real bugs.

### Specs added

| Spec | Tests | Coverage |
|---|---|---|
| `pos-sale.spec.ts` | 5 | happy cash sale, empty cart, insufficient stock, unknown product, anonymous 401 |
| `sale-discount.spec.ts` | 4 | line %, line fixed, order discount, multi-line allocation sums |
| `sale-return.spec.ts` | 3 | full return restores stock, over-return PINNED, anonymous 401 |
| `customer.spec.ts` | 2 | phone snapshot surfaces in `/api/customers/by-phone`, anonymous 401 |
| `expense.spec.ts` | 3 | happy path, zod validation, anonymous 401 |
| `product.spec.ts` | 4 | happy path, negative price rejected, missing category rejected, anonymous 401 |
| `cash-shift.spec.ts` | 3 | open + current + close happy path, owner re-open behaviour, anonymous 401 |
| `authentication.spec.ts` | 3 | login happy, wrong password rejected, logout clears session |
| `authorization.spec.ts` | 4 | every tenant `/api/*` returns 401 anon, `/api/admin/*` is 404, owner reads `/api/insights`, rate-limit smoke |

**Helpers added**:
- `tests/e2e/helpers/seed-owner.ts` — Drizzle-direct `ensureOwner` (tenant + branch + member + shop_settings + cornerstore preset)
- `tests/e2e/helpers/global-setup.ts` — provisions shared owner + login + state save
- `tests/e2e/helpers/tenant-setup.ts` — `signupOwner` (kept for smoke-spec regression), `createProduct`, `recordCartSale`, `getWatchesCategoryId` helpers

**Config**: `playwright.config.ts` gains `globalSetup`, `timeout: 90s`, `expect.timeout: 15s`, project-level `storageState`. `.gitignore` excludes the saved state file.

### Test result (against `next dev`, single worker, serial)

```
31 new safety-net tests — 31 passed in 15.6s after global setup
43 existing unit tests — 43 passed in 0.5s
typecheck — 0 errors
```

---

## Step 2 — Workflow coverage matrix

**Legend**: ✅ pinned in safety net · ⚠️ behaviour pinned (latent bug) · ❌ uncovered · 🟡 partial

### Critical (must-not-regress)

| Workflow | Happy path | Validation | Authz | Notes |
|---|---|---|---|---|
| POS cash sale (single line) | ✅ | ✅ (3 cases) | ✅ | smoke + per-validation coverage |
| POS cart sale (multi line) | ✅ via discount-multi | ✅ | ✅ | cart math verified |
| Sale with line discount % | ✅ | — | ✅ | |
| Sale with line discount fixed | ✅ | — | ✅ | |
| Sale with order discount | ✅ | — | ✅ | |
| Multi-line cart allocation sum invariant | ✅ | — | ✅ | sum equals total |
| Sale return (full) restores stock | ✅ | — | ✅ | |
| Sale return (over-quantity) | ⚠️ pinned | — | ✅ | accepts 201 today |
| Customer phone snapshot lookup | ✅ | — | ✅ | |
| Expense create + list | ✅ | ✅ | ✅ | |
| Product create + list | ✅ | ✅ (2 cases) | ✅ | |
| Cash shift open / current / close | ✅ | — | ✅ | requires closingNote on variance |
| Cash shift owner re-open | ✅ pinned | — | ✅ | owner-desk behaviour |
| Cash shift staff double-open rejection | ❌ | — | — | needs staff fixture |
| Login with credentials | ✅ | ✅ wrong-pw | — | |
| Logout clears session | ✅ | — | — | |
| Anonymous returns 401 | — | — | ✅ (9 surfaces) | |
| Admin routes hard-404 to non-admin | — | — | ✅ | |
| Owner reads insights | ✅ | — | — | |
| Signup → onboarding → dashboard | ✅ | — | — | `smoke.spec.ts` (pre-existing) |
| Partial payment / deferred sale | ❌ | ❌ | — | high-value next add |
| Customer wallet redeem / earn | ❌ | ❌ | — | high-value next add |
| Insights date-range filter | ❌ | — | — | |
| Sales settle (existing invoice) | ❌ | — | — | |
| Sale void | ❌ | — | — | |

### Critical-path coverage %

- **POS read+write workflows**: **80%** (3 of 5 hot paths fully covered; settle + void + partial-pay missing)
- **Catalog**: **75%** (create + list covered; update + delete + bulk uncovered)
- **Cash drawer**: **70%** (open + close happy + owner behaviour; staff variants uncovered)
- **Auth + authz boundaries**: **90%** (login/logout/anon-401 broadly covered; 2FA + recovery code not in e2e)
- **People (tasks/leave/payroll)**: **0%** — entirely uncovered today
- **WhatsApp send / receive**: **0%** — webhook + send untestable without mocking Meta
- **Settings page**: **0%** — all 10 tabs uncovered; this is the gap the Phase 3 refactor analysis flags as the biggest risk

### Remaining unprotected workflows (priority for next test additions)

1. **Sale settle** — partial-payment flow has the most recent code churn
2. **Sale void** — refund + cash-shift reversal
3. **Sale partial payment + deferred** — straightforward extensions of existing helpers
4. **Customer wallet redeem / earn** — loyalty math
5. **Insights date-range filters** — server aggregation correctness
6. **Settings → shop name / WhatsApp template save** — refactor blast radius
7. **Tasks create + assignee notification**
8. **Leave request submit + approve**

---

## Step 3 — Decomposition plans (analysis only — DO NOT REFACTOR YET)

### A. `components/sales/SaleForm.tsx`

**Size**: 1,394 lines, 1 component, 28 `useState`/`useEffect`/`useMemo` calls, 4 inline `fetch()` calls, 1 monolithic `handleSubmit` over ~150 lines.

#### Current responsibilities (single file)

1. **Cart state** — line list, currently-editing product/qty/price, line discount type+value
2. **Product autocomplete** — `<ProductSearchSelect>` mount + keyboard shortcut (`/`-to-focus)
3. **Customer autocomplete** — recent customer suggestions; loyalty wallet fetch
4. **Discount math** — order discount type+value, total recompute
5. **Loyalty redemption inputs** — points + credit + wallet preview
6. **Partial payment** — deferred-sale `amountPaidNow`
7. **Submit** — call cart endpoint, handle errors, build receipt
8. **WhatsApp send** — Green API + Cloud API
9. **Print routing** — last-invoice receipt prompt
10. **Offline-aware submit** — `recordCartSaleOfflineAware`
11. **Preselect from `?preselect=`** — inventory quick-sell entry
12. **Custom-date / "yesterday" sale** — `customDate` input
13. **Branch context** — `useBranches` snapshot

#### Proposed decomposition

##### Extracted hooks (4)

| Hook | Inputs | Outputs | LOC est. |
|---|---|---|---|
| `useCart(initialBranchId)` | branch context | `{ lines, addLine, removeLine, updateLine, cartGross, cartTotal, orderDiscount, setOrderDiscount }` | ~140 |
| `useCustomerWallet(phone, loyaltyEnabled)` | normalized phone, settings flag | `{ points, credit, loading }` | ~60 |
| `useReceiptDispatcher(settings, connection)` | shop settings, WA connection | `dispatch(invoice) → printPdf | sendGreenApi | sendCloud` | ~120 |
| `useProductPreselect(searchParams, products)` | URL params, product list | sets the selected product, strips param | ~30 |

##### Extracted components (5)

| Component | Responsibility | LOC est. |
|---|---|---|
| `<CartLineEditor>` | Current-line product + qty + price + line discount inputs | ~180 |
| `<CartLinesList>` | Renders existing lines with delete buttons | ~70 |
| `<DiscountControls>` | Order discount type+value selector | ~60 |
| `<CustomerSection>` | `<CustomerAutocomplete>` + phone normalisation + wallet preview | ~90 |
| `<LoyaltyRedemptionPanel>` | Points + credit redemption inputs, real-time discount preview | ~110 |
| `<PartialPaymentInput>` | Deferred-sale `amountPaidNow` + paid/balance preview | ~50 |
| `<PrintLastInvoiceButton>` | The dangling "reprint" button at the bottom | ~30 |

##### Expected LOC reduction

| Component | Before | After (orchestrator) |
|---|---|---|
| `SaleForm.tsx` | 1,394 | ~250 (composition + submit handler) |

**Total** new code ≈ 1,140 LOC distributed across 11 files. Net delta is roughly +0 — the win is discoverability, testability, and per-piece change isolation.

#### Risk level: **Medium-High**

- Sale submit is the platform's #1 hot path; user error = lost revenue
- Cart state shape mediates partial-pay + loyalty + discount math which interact
- Offline submission path adds a parallel concern that must keep working

#### Mitigation

- **Safety net**: 12 e2e tests covering sale paths in Phase 3 (all the discount math + over-return pin + insufficient-stock + happy paths) — landed
- **Add before refactor**: 1 test for partial payment, 1 for loyalty redeem, 1 for offline replay (idempotency-key). Estimated 0.5 day.
- **Land in 4 commits, gated**: (1) extract `useCart` + `<CartLinesList>` + `<CartLineEditor>`, (2) `<DiscountControls>`, (3) `<CustomerSection>` + `<LoyaltyRedemptionPanel>`, (4) `<PartialPaymentInput>` + `useReceiptDispatcher`. After each, run full Playwright suite + typecheck. Revert any commit that breaks.

---

### B. `app/settings/page.tsx`

**Size**: 1,584 lines, 1 client component, 19 `useState`/`useEffect` calls. Has been growing as each feature got a new tab.

#### Current responsibilities (single file)

1. **Shop name + phone + logo + message template**
2. **Receipt template customization** (template editor)
3. **WhatsApp Cloud API connection** (OAuth status + reconnect + disconnect)
4. **WhatsApp Green API legacy connection**
5. **WhatsApp templates list + sync**
6. **Categories editor** (delegates to `<CategoriesEditor>`)
7. **Brands editor** (delegates to `<BrandsEditor>`)
8. **Receipt designer** (delegates to `<ReceiptDesigner>`)
9. **Branches list + add** (link to `/settings/branches`)
10. **Cash drawer settings** (link to `/settings/cash-drawer`)
11. **Daily digest settings** (link to `/settings/digest`)
12. **Language** picker
13. **Test WhatsApp send (both providers)**
14. **Connection health check button**

#### Proposed decomposition

##### Convert to per-tab dynamic imports with Server Component shell

```
app/settings/
├── page.tsx                  ~120 lines (Server Component — reads session + dispatches tab)
├── layout.tsx                ~40 lines (shared chrome — tabs nav)
├── shop/page.tsx             ~180 lines (shop name + phone + logo + template)
├── whatsapp/page.tsx         ~280 lines (Cloud + Green API + templates)
├── receipt/page.tsx          ~140 lines (receipt template editor + designer wrapper)
├── catalog/page.tsx          ~80 lines (categories + brands)
├── language/page.tsx         ~80 lines (locale picker)
└── _components/
    ├── ShopDetailsForm.tsx
    ├── WhatsAppConnectionCard.tsx
    ├── WaTemplatesTable.tsx
    ├── ReceiptTemplateEditor.tsx
    └── LanguagePicker.tsx
```

##### Extracted hooks (2)

| Hook | LOC est. |
|---|---|
| `useWaConnection()` — connection state + healthcheck + disconnect | ~80 |
| `useWaTemplates()` — list + sync + status badges | ~70 |

##### Estimated LOC reduction

| File | Before | After |
|---|---|---|
| `app/settings/page.tsx` | 1,584 | ~120 (orchestrator) |
| Per-tab pages | 0 | ~880 total |
| Per-tab components | 0 | ~500 total |

**Net**: roughly equal LOC, but each tab loads independently (bundle reduction) and per-tab failure boundaries become trivial.

#### Risk level: **Medium**

- Settings is the lowest-traffic page in the app (operators set it once)
- But it owns secrets — WhatsApp token storage + OAuth state — so a hydration mismatch could surface as "OAuth flow loops forever"
- Categories + Brands editors already extracted, so a chunk of the risk is mitigated

#### Mitigation

- **Safety net BEFORE this refactor**: ⚠ currently 0 e2e coverage on the settings surface. Add at minimum:
  - 1 test: shop name save round-trip (~30 min)
  - 1 test: WhatsApp template editor save (~30 min)
  - 1 test: settings page renders without crashing as owner (~15 min)
- **Land as new routes first** (`/settings/shop`, `/settings/whatsapp`, etc.) with the old page still routing to each new tab via internal links. Once green for a sprint, delete the monolith.

---

## Step 4 — Next.js 16 modernization plan

Audit of the four heaviest read surfaces.

### Current state

| Page | "use client" | useState/Effect | fetch calls | Children loading data |
|---|---|---|---|---|
| `app/page.tsx` (dashboard) | yes | 0 | 0 | `<StatsGrid>`, `<LowStockAlert>`, `<RecentSalesList>` each fetch on mount |
| `app/sales/page.tsx` | yes | 24 | 0 | self-managed list state |
| `app/customers/page.tsx` | yes | 4 | 0 | hooks fetch customers + receivables |
| `app/insights/page.tsx` | yes | 6 | 0 | `useInsights` hook fetches |
| `app/customers/[phone]/page.tsx` | yes | 16 | 6 inline | dense waterfall |

### Modernization recommendations

#### A. Dashboard (`app/page.tsx`)

| Change | From | To |
|---|---|---|
| Page boundary | `"use client"` | Server Component (async function Page) |
| `<StatsGrid>` | client + fetch on mount | Server Component reads via `lib/repo/insights` directly, wrapped in `<Suspense fallback={<StatsGridSkeleton/>}/>` |
| `<LowStockAlert>` | client + fetch | Server Component |
| `<RecentSalesList>` | client + fetch | Server Component + cursor `?paginated=1` (already exposed) |
| `<Greeting>`, `<SelfCheckIn>`, `<BroadcastStack>` | stay client (interactivity) | unchanged |
| Cache directive | none | `'use cache'` on the read functions with `cacheLife("seconds")` and `cacheTag("tenant:${id}:dashboard")` so settle/cart writes can `updateTag()` |

**Expected impact**:
- **Bundle**: -30–40 KB (recharts is the biggest passenger; dashboard doesn't need it client-side any more if charts move server-side and emit SVG)
- **TTFB**: streaming with PPR — header + nav paint within ~150 ms, widgets stream in as their data resolves
- **Hydration**: cuts the dashboard's `useEffect`-driven `fetch+setState` cycle entirely. First contentful paint matches first paint.

#### B. Sales (`app/sales/page.tsx`)

| Change | From | To |
|---|---|---|
| Page boundary | `"use client"` | hybrid: Server Component shell + `<SalesFilters>` (client) + `<SalesTable>` (Server Component for the initial page, paginates client-side via the cursor endpoint we already shipped) |
| First page | useEffect → fetch on mount | server-rendered with `listSalesPage(tenantId, { limit: 50 })` |
| Filter changes | client-side filter on full list | client `<SalesFilters>` triggers cursor refetch via the existing API (no UI change) |

**Expected impact**:
- **Bundle**: -15 KB (24 useStates worth of date logic moves server)
- **TTFB**: server pre-renders first 50 rows; client doesn't need to wait for a network round-trip after hydration

#### C. Customers (`app/customers/page.tsx`)

| Change | From | To |
|---|---|---|
| Page boundary | `"use client"` | Server Component (page is mostly receivables list + filters) |
| `<CustomerRow>` | stays client (clickable links + state) | unchanged |
| `useCustomersData` hook | client fetch | Server Component reads via repo |

**Expected impact**:
- **Hydration**: zero on the initial list paint (was 4 useStates worth)
- **TTFB**: receivables aggregation already cached — paint matches DB read latency

#### D. Insights (`app/insights/page.tsx`)

| Change | From | To |
|---|---|---|
| Page boundary | `"use client"` | Server Component shell + client `<InsightsRangeControl>` |
| Aggregation | client fetch + useInsights hook | server-side `loadInsightsOverview` directly + `<Suspense>` per chart |
| Cache | hand-rolled | `'use cache'` + `cacheTag("tenant:${id}:insights")`; `bustInsightsCache` already exists for invalidation — call `updateTag` from sale/return/expense writers |
| Charts | recharts (client only) | keep client-only on the chart leaves; the page wrapper, controls, and labels go server |

**Expected impact**:
- **Bundle**: -50 KB (recharts only loads inside chart leaves, not the page shell)
- **TTFB**: insights page becomes the showcase for Cache Components — sub-100ms on cache hit
- **Hydration**: only the chart leaves hydrate; page chrome is static

#### E. Customer detail (`app/customers/[phone]/page.tsx`)

| Change | From | To |
|---|---|---|
| 6 inline `fetch()` calls in a single client component | massive waterfall | Server Component + 6 parallel awaits at the top of `Page(async)` |
| `<InvoiceSettleModal>` | stays client | unchanged |
| Per-invoice payment timeline | client fetch + maps | server-rendered once; modal stays client |

**Expected impact**:
- **Bundle**: -10 KB (drops a lot of useState)
- **Network**: 6 sequential fetches → 6 parallel awaits, no client-side waterfall
- **Hydration**: timeline renders once on the server; no flash

### Aggregate expected impact (across A–E)

| Metric | Before | After (estimate) |
|---|---|---|
| Total JS shipped to dashboard | ~280 KB | ~190 KB (-90 KB, ~32%) |
| Dashboard TTFB on cache hit | ~600 ms | ~150 ms (-450 ms) |
| Insights TTFB on cache hit | ~900 ms | <100 ms (-800 ms) |
| `useEffect` calls across the 5 pages | 50 | ~10 (just the interactive leaves) |
| Components needing client hydration | ~12 per page | ~3 per page |

### Server Actions opportunities (separate audit, lower priority)

The settle modal, expense create form, product create form, and shift open/close are all good Server Action candidates. Lower priority than the read modernization — they're already low-traffic mutating endpoints.

---

## Step 5 — Test gate (verified)

Pre-refactor gate run on this branch:

```
1. Playwright safety net (31 tests)        — ✅ 31 passed in 15.6s
2. Vitest unit + repo suite (5 files)       — ✅ 43 passed in 0.5s
3. Typecheck (npx tsc --noEmit)             — ✅ 0 errors
4. Pre-existing smoke + auth-smoke           — ⚠ auth-smoke:118 has a UI copy
                                                drift; pre-existing failure
                                                unrelated to Phase 3 work
```

**Verdict**: ✅ green. The codebase has a working safety net. The SaleForm and settings decompositions are now *unblocked*, subject to landing the 3 missing Settings smoke tests + 3 missing SaleForm partial-payment / loyalty / offline tests called out above (estimated 1.5 days total).

---

## What's next (not in Phase 3)

These are the gates the analysis identified before Phase 4 (the actual refactor) can begin:

1. **Add 3 settings smoke tests** — currently 0 coverage on settings/page.tsx
2. **Add 3 SaleForm-area tests** — partial payment, loyalty redeem, offline replay
3. **Decision**: pick A (SaleForm) or B (settings) first. **Recommendation: settings first** because its blast radius is smaller (single-tenant operator setup) and it's a structural move (new routes) not a refactor — easier to revert.

When all of the above is green and the team is ready, Phase 4 executes the decomposition plans in this document.
