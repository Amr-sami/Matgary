# Corner Store → Multi-Tenant SaaS — Migration Plan

> **For the executing agent:** This plan operates on a fresh clone of the Corner Store repo. The starting state is the current `main` branch of `cornerstore`. The end state is a multi-tenant SaaS that **looks and behaves identically** to Corner Store for any single tenant, but supports many independent stores, runs on PostgreSQL instead of Firebase, and lets each tenant define its own categories instead of having `watches`/`perfumes`/`sunglasses` baked into TypeScript.
>
> **Read this before writing any code:**
> - `AGENTS.md` (project root) — Next.js 16 / React 19 / Tailwind 4 are bleeding-edge. Verify APIs against `node_modules/next/dist/docs/` rather than relying on training data.
> - The auto-memory rule: **never modify `:root` or `@theme` in `app/globals.css`.** The cream/gold palette and CSS variable names are part of the product identity and must be preserved exactly. Theming-per-tenant is out of scope for v1.

---

## 0. Guiding Principles (non-negotiable)

1. **No visual regressions.** Every screen, component, animation, and interaction in Corner Store today must look and behave exactly the same after the migration when viewed inside a single tenant. The user explicitly said "we keep anything in corner store… with the same ui and the same everything." If a change risks breaking the look, redesign the change, not the UI.
2. **Surgical, not a rewrite.** Reuse `app/`, `components/`, `hooks/`, `lib/utils.ts`, `lib/pdfReceipt.ts`, `lib/csv.ts`, `lib/csvImport.ts`, `lib/customers.ts`, `lib/whatsapp.ts`, `lib/settings.ts` as-is wherever possible. The bulk of the work happens in `lib/firestore.ts`, `lib/firebase.ts`, `lib/types.ts`, and the hooks that wrap them.
3. **Preserve hook signatures.** `useProducts()`, `useSales()`, `useReturns()`, `useExpenses()`, `useShopSettings()`, `useCustomersData()`, `useInsights()`, `useSearch()` must keep returning the same shapes. Components must not need to change. The implementation behind each hook swaps from Firestore subscriptions to a Postgres-backed equivalent.
4. **Generalize without complicating the UX.** The 3-step add-product wizard, the inventory filters, the category buttons — all of these continue to exist; they're just driven by per-tenant data instead of a hardcoded enum. A new tenant who starts blank still gets the same wizard, but defines their own category icons and labels.
5. **Phased, always-runnable.** Every phase ends with `npm run dev` showing a working app. No "big bang" cutover.
6. **Auth first, then everything else.** Without auth, you cannot scope data per tenant safely. Phase 1 stops being optional the moment Phase 2 starts.
7. **Defer what the user said to defer:** Google OAuth, billing/pricing, custom domains, advanced roles. Email + password is enough for v1.

---

## 1. What Stays vs. What Changes

| Area | Stays | Changes |
|---|---|---|
| Pages (`app/*/page.tsx`) | All 11 routes, exact layouts | Wrapped in auth + tenant context |
| Components (`components/**`) | All ~70 components, all styles | None — they keep consuming the same hooks |
| Hooks (`hooks/**`) | Public signatures and return shapes | Internals swap from `onSnapshot` to a Postgres data-fetching pattern (see §6) |
| `lib/firestore.ts` | Function names + signatures (where possible) | Internals call Drizzle queries via API routes / server actions instead of Firestore SDK |
| `lib/types.ts` | Domain interfaces (`Product`, `Sale`, `Return`, `Expense`, `ShopSettings`, etc.) | `Category` and `Gender` change from string-literal unions to plain `string` (IDs from per-tenant tables); `CATEGORY_LABELS` and `GENDER_LABELS` move from constants to runtime data |
| `lib/firebase.ts` | — | **Deleted at end of Phase 5.** Replaced by `lib/db/` (Drizzle client) |
| `lib/pdfReceipt.ts`, `lib/csv.ts`, `lib/csvImport.ts`, `lib/customers.ts`, `lib/whatsapp.ts`, `lib/settings.ts`, `lib/utils.ts` | Logic preserved | `csvImport.ts` category parser becomes tenant-aware; `settings.ts` reads/writes Postgres |
| `app/globals.css`, theme tokens | **Untouched.** | — |
| `app/api/whatsapp/{send,send-pdf}/route.ts` | Endpoint shape | Reads tenant Green API creds from Postgres + auth-protected |
| WhatsApp message template, placeholders, fallback chain | Identical | Per-tenant template stored in Postgres |
| Receipt PDF (Cairo font, layout, 80mm) | Identical | Pulls shop name/phone/logo from per-tenant settings |
| Hardcoded `Category` (`watches`/`perfumes`/`sunglasses`) | — | Becomes per-tenant rows in `categories` table; first sign-up gets these three seeded by default so the experience matches Corner Store out of the box |
| Hardcoded `Gender` (`male`/`female`) | — | Becomes per-tenant rows in `genders` table (or, if simpler in v1, kept as a global enum — see §8 decision) |
| Hardcoded `Brand` list (watches only) | — | Becomes a per-tenant `brands` table, keyed to category |
| `ExpenseCategory`, `PaymentMethod` enums | Stay as global enums in v1 | Optional: make `ExpenseCategory` per-tenant later. `PaymentMethod` is universal — leave alone. |
| Auth | None today | Email + password (Auth.js v5) added in Phase 1 |

---

## 2. Tech Stack Decisions

| Layer | Choice | Rationale |
|---|---|---|
| Framework | **Stay on Next.js 16.2.3 + React 19.2.4 + Tailwind 4** | Already in the repo; touching versions invites regressions. Verify any new API usage against `node_modules/next/dist/docs/`. |
| Database | **PostgreSQL 16** | Replaces Firestore. Local dev via Docker (single container). Production target deferred. |
| ORM / migrations | **Drizzle ORM + `drizzle-kit`** | Lightweight, type-safe, plays well with App Router. Schemas live in `lib/db/schema.ts`. |
| Auth | **Auth.js v5 (NextAuth) — Credentials provider only** | Email + password with Argon2id hashing. Google provider deferred per user request. Sessions stored in DB (Drizzle adapter), not JWT, so revocation works. |
| File storage | **Local disk under `uploads/<tenant_id>/...` for v1** | Firebase Storage isn't actually used today (only configured). Receipts are generated in-memory. Logos can be served from disk. Move to S3/MinIO when self-hosting publicly. |
| WhatsApp | **Green API (unchanged)** | Per-tenant credentials in Postgres. The two API routes are kept; only the credential lookup changes. |
| PDF | **`pdf-lib` + Cairo font (unchanged)** | Identical receipt output. |
| Background jobs | **None in v1** | No queue today; not needed yet. |
| Testing | **One Vitest + a single tenant-isolation test** | Mandatory: see §10. |

**No new dependencies beyond:** `drizzle-orm`, `drizzle-kit`, `pg` (or `postgres`), `next-auth@beta`, `@auth/drizzle-adapter`, `argon2` (or `bcryptjs`), `zod` (already implicitly needed; check if present), `vitest`.

---

## 3. Multi-Tenancy Model

**Strategy:** shared database, shared schema, `tenant_id uuid not null` on every business table. Postgres Row-Level Security (RLS) as a defense-in-depth layer, but the primary enforcement is in application code via a tenant-scoped DB client.

### Tenant resolution

The user's session contains `userId`. From `userId`, we resolve `tenantId` via `tenant_members`. **In v1 each user belongs to exactly one tenant** (the one they created on sign-up). Multi-tenant memberships are out of scope.

A helper `getCurrentTenantId()` runs at the top of every server action / API route and throws if no session. All Drizzle queries pass `tenantId` explicitly. There is no global "client" that lets you query without it.

### RLS (defense-in-depth)

For every business table:

```sql
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON products
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

A request-scoped middleware runs `SET LOCAL app.tenant_id = '<uuid>'` on the connection before any query. If the app code forgets to filter, RLS still blocks the read.

### Subdomains: NOT in v1

The user did not ask for `<slug>.app.com` routing. Skip it. All tenants live on a single host; their data is segregated by the session. Routes stay exactly as they are today (`/`, `/inventory`, `/sales`, …). Subdomains are a Phase-6 concern when the marketing site goes live.

---

## 4. Data Model — Postgres Schema

Every table marked **(scoped)** has `tenant_id uuid not null references tenants(id) on delete cascade` and is covered by an RLS policy.

Drizzle schemas live in `lib/db/schema.ts`. Migrations live in `lib/db/migrations/` (generated by `drizzle-kit`).

### Auth & Tenancy (global)

```
users
  id              uuid pk
  email           text unique not null
  name            text
  password_hash   text                  -- nullable to allow OAuth in future
  email_verified_at timestamptz
  created_at      timestamptz default now()

accounts          -- Auth.js OAuth links (empty in v1; schema present for future)
sessions          -- Auth.js sessions
verification_tokens

tenants
  id              uuid pk
  name            text not null         -- "My Boutique"
  slug            text unique not null  -- url-safe, used later for subdomains
  currency        text not null default 'EGP'
  language        text not null default 'ar'
  timezone        text not null default 'Africa/Cairo'
  created_at      timestamptz default now()

tenant_members
  tenant_id       uuid not null references tenants(id) on delete cascade
  user_id         uuid not null references users(id) on delete cascade
  role            text not null default 'owner'   -- owner | admin | cashier (full RBAC deferred)
  joined_at       timestamptz default now()
  primary key (tenant_id, user_id)
```

### Catalog (scoped)

```
categories                    -- replaces the hardcoded Category enum
  id              uuid pk
  tenant_id       uuid
  key             text not null         -- machine name, e.g. "watches"; unique per tenant
  label           text not null         -- display name in tenant's language, e.g. "ساعات"
  icon            text                  -- lucide icon name, e.g. "Watch" | "FlaskConical" | "Glasses"
  position        int not null default 0
  created_at      timestamptz default now()
  unique (tenant_id, key)

genders                       -- replaces the hardcoded Gender enum (see §8 for decision)
  id              uuid pk
  tenant_id       uuid
  key             text not null         -- e.g. "male", "female", "unisex", "kids"
  label           text not null
  position        int not null default 0
  unique (tenant_id, key)

brands                        -- per-tenant, optionally scoped to a category
  id              uuid pk
  tenant_id       uuid
  category_id     uuid references categories(id) on delete cascade  -- nullable = brand applies to any category
  name            text not null
  unique (tenant_id, category_id, name)

products
  id              uuid pk
  tenant_id       uuid
  category_id     uuid not null references categories(id) on delete restrict
  gender_id       uuid references genders(id) on delete set null   -- nullable; not all categories have gender
  brand           text                  -- free text or chosen from brands table
  name            text not null
  quantity        int not null default 0
  price           numeric(12,2) not null
  cost_price      numeric(12,2)
  low_stock_threshold int not null default 3
  sku             text
  tags            text[] default '{}'
  supplier        text
  location        text
  created_at      timestamptz default now()
  updated_at      timestamptz default now()
  -- indexes: (tenant_id, created_at desc), (tenant_id, category_id), (tenant_id, sku)
```

### Operations (scoped)

```
sales                       -- one row per LINE ITEM; cart sales share invoice_id
  id              uuid pk
  tenant_id       uuid
  invoice_id      text                  -- e.g. "INV-XYZABC12"; null only for legacy single-line sales
  product_id      uuid not null references products(id) on delete restrict
  product_name    text not null         -- snapshot at sale time
  category_id     uuid not null         -- snapshot
  gender_id       uuid                  -- snapshot
  brand           text                  -- snapshot
  quantity_sold   int not null
  price_per_unit  numeric(12,2) not null
  cost_price_at_sale numeric(12,2)
  subtotal        numeric(12,2) not null
  discount_type   text                  -- 'percentage' | 'fixed'
  discount_value  numeric(12,2)
  discount_amount numeric(12,2)
  total_price     numeric(12,2) not null
  sale_date       timestamptz not null default now()
  is_returned     boolean not null default false
  returned_at     timestamptz
  returned_quantity int
  note            text
  customer_name   text
  customer_phone  text                  -- normalized (20...) or null
  payment_method  text                  -- 'cash' | 'instapay' | 'card' | 'deferred'
  is_paid         boolean not null default true
  paid_at         timestamptz
  -- indexes: (tenant_id, sale_date desc), (tenant_id, invoice_id), (tenant_id, customer_phone)

returns
  id              uuid pk
  tenant_id       uuid
  sale_id         uuid not null references sales(id) on delete cascade
  product_id      uuid not null
  product_name    text not null
  returned_quantity int not null
  return_date     timestamptz not null default now()
  reason          text

expenses
  id              uuid pk
  tenant_id       uuid
  title           text not null
  amount          numeric(12,2) not null
  category        text not null         -- 'rent' | 'salaries' | … (global enum, kept simple)
  date            timestamptz not null default now()
  note            text

product_history
  id              uuid pk
  tenant_id       uuid
  product_id      uuid not null
  product_name    text not null
  type            text not null         -- 'created' | 'updated' | 'restocked' | 'decreased' | 'sold' | 'returned'
  delta           int
  quantity_after  int
  note            text
  created_at      timestamptz default now()

shop_settings                -- one row per tenant
  tenant_id       uuid pk
  shop_name       text not null
  shop_phone      text
  logo_path       text                  -- relative path under /uploads/<tenant_id>/
  auto_open_whatsapp boolean not null default true
  message_template text not null         -- copied from lib/settings.ts DEFAULT_TEMPLATE on tenant create
  green_api_enabled boolean not null default false
  green_api_instance_id text
  green_api_token text                  -- ENCRYPT AT REST — see §11
  green_api_url   text
  send_as_pdf     boolean not null default false
  updated_at      timestamptz default now()
```

### Atomicity rules (carry over from current Firestore code)

These transactions exist today via Firestore's `runTransaction`. Reproduce them with Postgres `BEGIN ... COMMIT` (or Drizzle's `db.transaction()`):

- **Recording a single sale:** decrement `products.quantity`, insert `sales` row, insert `product_history` row — one transaction.
- **Recording a cart sale:** decrement N products, insert N `sales` rows (sharing `invoice_id` and `sale_date`), insert N history rows — one transaction. Proportional discount allocation logic from `lib/firestore.ts` ports verbatim.
- **Voiding a sale:** restock product, delete sale row, log history — one transaction.
- **Editing a sale (qty change):** compute delta, restock/destock, update sale, log history — one transaction.
- **Recording a return:** restock, mark `sales.is_returned = true`, insert `returns` row — one transaction.
- **Bulk product update / delete:** one transaction per call.

Drizzle supports nested transactions on Postgres; use them.

---

## 5. Auth & Sign-up Flow

### Auth provider config

- **Auth.js v5** with the **Credentials provider** only.
- Drizzle adapter writes `users`, `accounts`, `sessions`, `verification_tokens` to the same Postgres DB.
- Sessions are **database sessions** (not JWT), so logout/revocation work cleanly.
- Cookie: secure, httpOnly, SameSite=lax, 30-day rolling expiry.
- Password hashing: Argon2id (`argon2` package). 8-char minimum, 128-char max. No other complexity rules in v1.
- No email verification in v1 (user said defer the heavy stuff). Stub the column so we can require it later.

### New routes

```
app/(auth)/signup/page.tsx           -- email, password, store name → creates user + tenant + membership
app/(auth)/login/page.tsx            -- email, password
app/(auth)/onboarding/page.tsx       -- post-signup wizard (see below)
app/api/auth/[...nextauth]/route.ts  -- Auth.js handler
```

`(auth)` is a route group so these pages can use a different layout (no `AppShell`, no sidebar — just a centered card matching the Corner Store visual style: cream background, gold accents).

### Middleware

`middleware.ts` at repo root:
- Public paths: `/login`, `/signup`, `/api/auth/*`, `/r/[id]` (public receipts — keep this open as today).
- Anything else: require session. Redirect to `/login?next=...`.
- Onboarding gate: if user has no completed `shop_settings.shop_name`, redirect to `/onboarding`.

### Sign-up wizard (post first sign-up, on `/onboarding`)

Three small steps, each fits on one screen, styled to match the existing Corner Store cards:

1. **"Tell us about your store"** — `shop_name` (required), `shop_phone`, `currency` (default EGP), `language` (default ar). Saved to `tenants` + `shop_settings`.
2. **"Pick your starting point"** — one of:
   - **"Like Corner Store"** (default, big card) → seeds the three categories `watches`, `perfumes`, `sunglasses` with the same Arabic labels and lucide icons currently in `Step1Category.tsx`, plus `male`/`female` genders, plus the watch brand list currently hardcoded in the wizard.
   - **"Start blank"** → seeds nothing. User adds categories from Settings later.
   - (Future: more presets like Pharmacy, Café — not in v1.)
3. **"You're set"** — quick checklist linking to `/add-product`, `/sales`, `/settings`. Mark onboarding complete and land on `/` (dashboard).

> The "Like Corner Store" preset is what makes the user's requirement work: a brand-new tenant, with zero clicks beyond the wizard, gets the **identical Corner Store experience**. The migration is then truly a generalization, not a behavior change.

### Defer (do not build in v1)

- Google OAuth
- Email magic link
- Email verification gate
- Password reset
- Multi-user invitations
- Per-role permissions (everyone is `owner` in v1)
- Account deletion / store deletion
- Billing / subscriptions / pricing

---

## 6. Replacing Firestore Subscriptions

Firestore's `onSnapshot` gives every page real-time updates. Postgres doesn't ship with that out of the box, and the user did not ask for live multi-device sync. Drop real-time in v1; rely on **fetch-on-mount + revalidate-on-mutation**.

### Pattern

For each hook (e.g. `useProducts`):

1. Page renders → hook fetches via `fetch('/api/products')` (or directly via a Server Action returning typed data).
2. Hook exposes `{ data, loading, error, refresh }`.
3. Mutations (`addProduct`, `updateProduct`, …) call their server action, then call `refresh()` on success.
4. **Components don't change.** They still get the same array of `Product` they did before. The difference is invisible to them: data refreshes when something is changed, not in real time across browser tabs.

### Where to put data fetching

Two acceptable patterns; the agent should pick **one and stay consistent**:

- **Server Actions + RSC where possible** (preferred). Pages become Server Components that fetch initial data; client components mount with that data; mutations are server actions imported into client components. Hooks shrink because RSC handles initial load.
- **API routes + client hooks** (closer to current code shape). Each `lib/firestore.ts` function becomes an API route under `app/api/...`. Hooks call `fetch`. Less idiomatic for App Router but a smaller diff from today's code.

Given the principle "preserve hook signatures," start with the **API-route + client-hook** pattern in Phases 2–4 to minimize changes, then opportunistically migrate hot pages (dashboard, inventory) to Server Actions in Phase 5 if it simplifies the code.

### What about real-time?

If the user later wants real-time (e.g. a cashier seeing inventory changes from another device), add **`postgres-js` LISTEN/NOTIFY** or a Pusher/Ably channel. Don't do it speculatively.

---

## 7. Generalizing the Hardcoded Categories

This is the single most important behavioral change. Get it right and the rest of the system "just works" for any vertical.

### Current state (read this carefully)

- `lib/types.ts` exports `type Category = "watches" | "perfumes" | "sunglasses"` and `CATEGORY_LABELS: Record<Category, string>`.
- `lib/types.ts` exports `type Gender = "male" | "female"` and `GENDER_LABELS`.
- `components/add-product/Step1Category.tsx` hardcodes 3 buttons with lucide icons (`Watch`, `FlaskConical`, `Glasses`) and Arabic labels.
- `components/add-product/Step2Gender.tsx` hardcodes the 2 gender buttons.
- `app/add-product/page.tsx` has a watch-brand list (custom dropdown logic — `form.brand === "Other" ? form.customBrand : form.brand`).
- `lib/csvImport.ts:43-50` parses both English and Arabic spellings of the 3 categories.
- Many filter UIs in `app/inventory/page.tsx`, `app/sales/page.tsx`, `app/reports/page.tsx`, `app/insights/page.tsx`, etc., reference `Category` as if it's a fixed set.

### Target state

- `Category` is no longer a TS literal union. It becomes `string` (a UUID from `categories.id`) at the type level. Pages and components that need labels look them up via the tenant's category list.
- A new hook `useCategories()` fetches the per-tenant categories list and returns `{ data: Category[], byId: Record<string, Category>, loading, error, refresh }`.
- Same for `useGenders()` and `useBrands()`.
- `Step1Category.tsx` renders buttons by mapping over `useCategories().data`, looking up the icon component from a small dictionary (`{ Watch, FlaskConical, Glasses, ... }`) keyed by the `categories.icon` column. If a tenant adds a category with an icon name we don't ship, fall back to a default (e.g. `Package`).
- `Step2Gender.tsx` does the same for `useGenders()`.
- Brand selection in the watch step pulls from `useBrands(categoryId)` instead of the hardcoded array. The "Other" + custom-brand UX is preserved.
- Filter dropdowns across the app build their options from `useCategories()` etc.
- `csvImport.ts` resolves a category cell by matching against the tenant's category `key` and `label` (case-insensitive, both languages).

### Settings UI for managing categories (Phase 4)

A new section in `/settings` lets a tenant:
- Add a category: key (auto-slugified from label), label, icon (picker from a small fixed lucide set), position.
- Reorder categories (drag handle).
- Edit label, icon, position.
- Delete a category — **only if no products reference it.** Otherwise show "Cannot delete: 47 products use this category."
- Same UI for genders and brands.

This UI doesn't need to be fancy. A simple list with inline edit, matching the existing settings card style, is enough.

### Why this preserves the UX

A brand-new tenant who picks "Like Corner Store" in onboarding sees, on `/add-product`, exactly the three buttons they see today, with the same icons and the same Arabic labels — because we seeded their `categories` table with rows that produce that exact output. Inventory filters show the same options. CSV import works the same. Receipts look the same.

A tenant who picks "Start blank" gets the same wizard flow, but the first category screen shows an empty state with "Add your first category" (a button into Settings).

---

## 8. Open Decisions (lock these before Phase 2)

The user should answer these. The agent should not guess:

1. **Genders per tenant or global?** Today only male/female exist. If we keep them global, the schema simplifies (`gender` column becomes a text enum). If per-tenant, a clothing store can add "kids" and "unisex" without code changes. **Recommendation:** per-tenant table — costs little, avoids a future migration.
2. **`ExpenseCategory` per tenant?** Today: 6 fixed values. **Recommendation:** keep global in v1 (low value to customize, high noise in UI). Revisit if a tenant asks.
3. **Currency formatting.** `lib/utils.ts:formatPrice()` hardcodes `" EGP"` and 2 decimals. Make it read `tenants.currency` and use `Intl.NumberFormat(language, { style: 'currency', currency })`.
4. **Logo upload.** Today the logo is `/public/logo.png`. For v1: allow tenants to upload a PNG/JPG to `/uploads/<tenant_id>/logo.png`, served via a Next.js route handler that checks tenant ownership. Use `multipart/form-data`, max 1 MB, resize server-side later if needed.
5. **Public receipt page (`/r/[id]`).** Today it's open. Should it stay open (anyone with the URL can view) or require a token? **Recommendation:** keep open in v1 (the user shares it via WhatsApp anyway), but include the tenant slug in the URL (`/r/<tenant_slug>/<sale_id>`) so receipts are scoped per tenant and IDs from one tenant can't be guessed against another.
6. **Drizzle Postgres driver.** `node-postgres` (`pg`) is the default; `postgres` (Porsager) is faster but uses tagged templates. Either works with Drizzle. **Recommendation:** `postgres` — Drizzle docs use it as the canonical example for Postgres + RLS `SET LOCAL`.

---

## 9. File-by-File Porting Map

This is the agent's checklist. Each row is a concrete edit.

| File | Action | Notes |
|---|---|---|
| `package.json` | Add deps: `drizzle-orm`, `drizzle-kit`, `postgres`, `next-auth@beta`, `@auth/drizzle-adapter`, `argon2`, `vitest`. Remove: `firebase`. | Keep all other deps. |
| `lib/firebase.ts` | Delete at end of Phase 5. Keep through Phases 1–4. | — |
| `lib/db/index.ts` (new) | Export `db` (Drizzle client) and `withTenant(tenantId, fn)` helper that opens a transaction and runs `SET LOCAL app.tenant_id`. | Single source of truth for DB access. |
| `lib/db/schema.ts` (new) | All Drizzle tables from §4. | — |
| `lib/db/migrations/` (new) | Generated by `drizzle-kit generate`. Initial migration is one big DDL file. | Commit migrations. |
| `lib/auth.ts` (new) | Auth.js config: Credentials provider, Drizzle adapter, session callbacks that attach `tenantId` to the session. | — |
| `lib/firestore.ts` | Rewrite each function. Keep names: `addProduct`, `updateProduct`, `deleteProduct`, `bulkUpdateProducts`, `bulkDeleteProducts`, `recordSale`, `recordCartSale`, `updateSale`, `voidSale`, `markInvoicePaid`, `recordReturn`, `addExpense`, `deleteExpense`, `recordHistoryEvent`, `subscribeToProducts`/`subscribeToSales`/etc. | The `subscribe*` functions become plain `list*`/`get*` async functions. Hooks call them via fetch or server action. |
| `lib/types.ts` | `Category` and `Gender` change from string-literal unions to `string`. Drop `CATEGORY_LABELS` / `GENDER_LABELS` (replaced by per-tenant data). Keep `Product`, `Sale`, `Return`, `Expense`, `ShopSettings`, `PaymentMethod`, `ExpenseCategory`, `ProductHistoryEvent` — same shapes, just `category` and `gender` are now category/gender IDs. | Search-and-replace in components: anywhere that reads `CATEGORY_LABELS[product.category]` becomes `categoryById[product.categoryId]?.label`. |
| `lib/settings.ts` | `getShopSettings(tenantId)` and `setShopSettings(tenantId, partial)` hit Postgres. `DEFAULT_TEMPLATE`, `substitute()`, `normalizePhone()` stay as pure functions. | — |
| `lib/whatsapp.ts` | Unchanged. | — |
| `lib/pdfReceipt.ts` | Unchanged shape. Reads shop name/phone/logo from passed-in settings (already does). | Logo path resolution changes from `/public/logo.png` to `/uploads/<tenant_id>/logo.png`. |
| `lib/csvImport.ts` | Category parser becomes tenant-aware: takes a `categories: Category[]` arg and matches by `key` or `label`. | Same for genders. |
| `lib/csv.ts`, `lib/customers.ts`, `lib/utils.ts` | Unchanged except `formatPrice()` (see §8 #3). | — |
| `hooks/useProducts.ts` | Replace `onSnapshot` with `fetch('/api/products')` + local state. Expose `refresh()`. | Same return shape. |
| `hooks/useSales.ts`, `useReturns.ts`, `useExpenses.ts`, `useShopSettings.ts` | Same pattern. | — |
| `hooks/useCustomersData.ts`, `useInsights.ts`, `useSearch.ts` | Unchanged — they derive from the data the above hooks already return. | — |
| `hooks/useCategories.ts`, `useGenders.ts`, `useBrands.ts` (new) | Fetch from `/api/categories` etc. Return `{ data, byId, loading, error, refresh }`. | — |
| `app/api/products/route.ts` (new) | `GET` returns tenant's products. `POST` creates one. Auth-gated, tenant-scoped. | — |
| `app/api/products/[id]/route.ts` (new) | `PATCH`, `DELETE`. | — |
| `app/api/products/bulk/route.ts` (new) | Bulk update / delete. | — |
| `app/api/sales/route.ts`, `app/api/sales/[id]/route.ts`, `app/api/sales/cart/route.ts`, `app/api/sales/[id]/void/route.ts`, `app/api/sales/invoice/[id]/paid/route.ts` (new) | Map to existing `lib/firestore.ts` functions one-to-one. | — |
| `app/api/returns/route.ts`, `app/api/expenses/route.ts`, `app/api/expenses/[id]/route.ts`, `app/api/categories/route.ts`, `app/api/categories/[id]/route.ts`, `app/api/genders/route.ts`, `app/api/brands/route.ts`, `app/api/settings/route.ts`, `app/api/uploads/logo/route.ts`, `app/api/r/[tenant_slug]/[sale_id]/route.ts` (new) | One per resource. | — |
| `app/api/whatsapp/send/route.ts`, `app/api/whatsapp/send-pdf/route.ts` | Add auth check. Read tenant Green API creds from DB (don't accept them from the client anymore — security upgrade). | The client sends `{ phone, message, saleId? }`; the server looks up creds itself. |
| `app/layout.tsx` | Wrap app in `<SessionProvider>` (Auth.js). Keep RTL, Cairo font, body classes — **untouched**. | — |
| `app/page.tsx` and every other `app/*/page.tsx` | If staying as Client Components: no change to JSX, only the auth-gated wrapping in middleware. If migrating to RSC: convert to async server components, fetch initial data, pass to client child. | Defer the RSC conversion if it risks visual regression. |
| `app/(auth)/signup/page.tsx`, `app/(auth)/login/page.tsx`, `app/(auth)/onboarding/page.tsx`, `app/(auth)/layout.tsx` (new) | Auth pages styled to match Corner Store visual language. | Use existing `components/ui/*`. |
| `app/r/[id]/page.tsx` | Move to `app/r/[tenant_slug]/[sale_id]/page.tsx` (see §8 #5). | Receipt rendering identical. |
| `components/add-product/Step1Category.tsx` | Replace the hardcoded `CATEGORIES` array with `useCategories().data`. Map `categories.icon` (a string) to a lucide component via a small lookup. | Visual output identical for a tenant seeded with the Corner Store preset. |
| `components/add-product/Step2Gender.tsx` | Same for `useGenders()`. | — |
| `app/add-product/page.tsx` | Replace hardcoded watch-brand list with `useBrands(categoryId)`. | — |
| `app/inventory/page.tsx`, `app/sales/page.tsx`, `app/reports/page.tsx`, `app/insights/page.tsx` | Wherever filter UIs reference category/gender, source from the new hooks. Wherever labels are looked up via `CATEGORY_LABELS` / `GENDER_LABELS`, use `byId[id]?.label`. | Mechanical change. Grep `CATEGORY_LABELS` and `GENDER_LABELS` and replace each call site. |
| `app/settings/page.tsx` | Add new sections: "Categories", "Genders", "Brands", "Logo upload". Keep existing WhatsApp section. | — |
| `middleware.ts` (new) | Auth gate + onboarding gate. | — |
| `.env.example` (new) | `DATABASE_URL`, `AUTH_SECRET`, optional `NEXTAUTH_URL`. | Document required env vars. |
| `docker-compose.yml` (new) | One service: `postgres:16` with a volume. That's it for v1. | — |
| `tests/isolation.test.ts` (new) | The mandatory cross-tenant isolation test (see §10). | — |
| `vitest.config.ts` (new) | Vitest config pointing at `tests/`. | — |
| `README.md` | Update setup instructions: `docker compose up -d`, `npm install`, `npm run db:migrate`, `npm run dev`. | — |

---

## 10. Tenant Isolation Test (mandatory before merging Phase 2)

A single Vitest file at `tests/isolation.test.ts`:

```
1. Spin up a test Postgres (or use TRUNCATE between tests on the dev DB).
2. Create tenant A + user A; create tenant B + user B.
3. As user A: insert a product, a sale, an expense, a return, a custom category.
4. As user B: list products, sales, expenses, returns, categories.
5. Assert: every list returns 0 rows.
6. As user B: try to GET /api/products/<A_product_id>, PATCH it, DELETE it.
7. Assert: each call returns 404 (not 403, to avoid existence-disclosure).
8. Bonus: with `app.tenant_id` unset, run a raw SELECT on products. Assert: 0 rows (RLS catches it).
```

This test runs in CI on every PR. A failure blocks merge. The user said this is existential — treat it that way.

---

## 11. Secrets & Security Notes

- **Green API token at rest:** symmetric encryption with a key from `process.env.SECRET_KEY` (AES-256-GCM via Node's `crypto`). Decrypt only inside the WhatsApp API route on the server. Never send the token to the client. The settings UI shows `••••••••` for the token field with an "edit" affordance.
- **Password hashing:** Argon2id with sane defaults (`memoryCost: 19456, timeCost: 2, parallelism: 1` — Auth.js docs example).
- **Session cookie:** httpOnly, secure (in production), SameSite=lax.
- **Auth.js secret:** `AUTH_SECRET` env var, 32+ random bytes. Generated in `.env.example` setup instructions.
- **Receipt URLs (`/r/...`):** scope by tenant slug to prevent cross-tenant ID guessing.
- **CSV import:** stream and validate row-by-row, cap at 10k rows per upload, reject rows that reference categories the tenant doesn't have.
- **No raw SQL from user input.** All Drizzle queries use parameterized values; no string concatenation.

---

## 12. Phased Delivery

Each phase ends with a working app. Each phase is one PR (or one logical commit series). Don't start phase N+1 until phase N is verified locally.

### Phase 0 — Repo prep (½ day)

- New repo created from this clone.
- `docker-compose.yml` with Postgres 16.
- `.env.example` and local `.env` with `DATABASE_URL`.
- Add `drizzle-orm`, `drizzle-kit`, `postgres`, `vitest` to deps.
- `npm run db:up` (composes up Postgres), `npm run db:migrate`, `npm run dev`, `npm run test` scripts in `package.json`.

**Verify:** `docker compose up -d`, app still runs against Firebase as today, `psql` connects to Postgres.

### Phase 1 — Auth + tenancy skeleton (1–2 days)

- `lib/db/schema.ts` with `users`, `accounts`, `sessions`, `verification_tokens`, `tenants`, `tenant_members`, `shop_settings` (the last so onboarding can write it).
- `lib/db/index.ts` with the `db` client and `withTenant()` helper.
- `lib/auth.ts` with Auth.js Credentials provider + Drizzle adapter.
- `app/(auth)/signup`, `app/(auth)/login`, `app/(auth)/onboarding` pages, styled to match Corner Store.
- `middleware.ts` enforcing auth + onboarding gates.
- RLS enabled on `shop_settings` (the only business table that exists yet).
- Onboarding "Like Corner Store" preset seeds an empty `shop_settings` (no products yet — Phase 2 adds the categories preset).

**Verify:** sign up two distinct accounts, both reach the dashboard, both see the existing Firebase data (still wired). The dashboard works because it still reads Firestore — that's fine; we haven't migrated the data layer yet.

### Phase 2 — Catalog: categories, genders, brands, products (3–5 days)

- Add `categories`, `genders`, `brands`, `products`, `product_history` to schema. RLS on each.
- Update onboarding "Like Corner Store" preset to seed the three Corner Store categories, the two genders, and the watch brand list.
- Implement `/api/categories`, `/api/genders`, `/api/brands`, `/api/products`, `/api/products/[id]`, `/api/products/bulk`.
- Rewrite `lib/firestore.ts` product functions on top of Drizzle.
- Rewrite `hooks/useProducts.ts` to fetch from the API. Add `useCategories`, `useGenders`, `useBrands`.
- Update `Step1Category.tsx`, `Step2Gender.tsx`, `app/add-product/page.tsx` to consume the hooks.
- Update `app/inventory/page.tsx` filters and label lookups.
- Update `lib/csvImport.ts` to take tenant categories.
- Write the isolation test (§10) — at this point it can already validate products, categories, brands.

**Verify:** with a fresh "Like Corner Store" tenant, the add-product wizard, inventory page, and CSV import behave identically to the Firebase version. With a "Start blank" tenant, the wizard shows an empty-state CTA into Settings (settings UI for categories comes in Phase 4 — temporarily, blank tenants can't add products; that's acceptable for one phase).

### Phase 3 — Operations: sales, returns, expenses, history (3–5 days)

- Add `sales`, `returns`, `expenses` to schema. RLS on each.
- Implement remaining APIs.
- Rewrite `lib/firestore.ts` sale/return/expense functions on Drizzle, preserving every transaction boundary from the current code.
- Update `useSales`, `useReturns`, `useExpenses`.
- `lib/customers.ts`, `useCustomersData.ts`, `useInsights.ts`, `useSearch.ts` should need **no changes** — they consume the hook outputs. Verify this; if any of them touch Firestore directly, port that too.
- Receipt generation works against Postgres data. Move `/r/[id]` → `/r/[tenant_slug]/[sale_id]`.

**Verify:** record a sale, edit it, void it, return it, mark deferred as paid, view the receipt, see it on the dashboard, see the history event. Compare side-by-side with the Firebase version on a second machine: pixel-identical.

### Phase 4 — Settings, WhatsApp, logo upload, category management UI (2–3 days)

- `shop_settings` reads/writes go through Postgres.
- WhatsApp API routes look up creds from DB; encrypt token at rest.
- `/settings` page gains: Categories editor, Genders editor, Brands editor, Logo upload.
- Logo served from `/uploads/<tenant_id>/logo.png` via a tenant-checked route handler.
- `lib/pdfReceipt.ts` reads logo from the new path (or falls back to the default Corner Store logo if none uploaded).

**Verify:** on a "Start blank" tenant, add a custom category ("Headphones") with a custom icon, then add a product in that category. Send a WhatsApp receipt. Upload a logo and confirm it appears on the PDF.

### Phase 5 — Cut Firebase loose (1 day)

- Remove `firebase` from `package.json`.
- Delete `lib/firebase.ts`.
- Grep for any remaining Firestore imports — there should be none.
- Update `README.md`.

**Verify:** `npm install` from a clean `node_modules` succeeds. `npm run build` succeeds. `npm run test` passes including the isolation test.

### Phase 6 (deferred — not part of v1)

- Google OAuth, magic link, password reset
- Email verification gate
- Team invitations + RBAC
- Subdomain routing (`<slug>.app.com`)
- Custom domains
- Per-tenant theme tokens
- Real-time updates (LISTEN/NOTIFY)
- Public marketing site
- Billing / subscriptions
- More starter presets (Pharmacy, Café, …)

---

## 13. Local Dev Setup (final state, post-Phase 5)

```bash
# Prereqs: Node 20+, Docker, npm
git clone <new-repo>
cd <new-repo>
cp .env.example .env            # fill DATABASE_URL, AUTH_SECRET, SECRET_KEY
docker compose up -d            # postgres only
npm install
npm run db:migrate              # drizzle-kit migrate
npm run dev                     # http://localhost:3000

# Tests
npm run test                    # vitest (includes isolation test)
```

---

## 14. What This Plan Explicitly Is Not Doing

- Not adding Google OAuth, magic links, billing, or pricing — user said "we can make it later."
- Not adding subdomains, custom domains, marketing site, or e-commerce checkout.
- Not introducing real-time multi-device sync. If you need it, add `LISTEN/NOTIFY` later.
- Not changing colors, theme tokens, font, layout, or any visual element of Corner Store.
- Not adding RBAC beyond a single `owner` role per tenant.
- Not building a full no-code attribute/schema editor like the previous `saas-plan.md` proposed. Categories, genders, and brands are simple per-tenant lookup tables. Per-category custom attributes (size, scent, etc.) are a Phase-6 concern. The existing Corner Store schema (name, qty, price, sku, tags, supplier, location, brand, gender) is enough for the initial verticals.
- Not migrating data from any existing Firestore project. Each new tenant starts from scratch via onboarding. (If the user later needs to import the original Corner Store's Firestore data into one specific tenant, write a one-off script then.)
- Not refactoring code for the sake of refactoring. Every change in this plan is justified by either (a) Postgres replacing Firebase, (b) auth/tenancy being added, or (c) hardcoded categories becoming per-tenant.

---

## 15. Definition of Done (v1)

- Two unrelated tenants can sign up, complete onboarding, and use every Corner Store feature without ever seeing each other's data.
- A "Like Corner Store" tenant has a UX visually identical to the current Firebase app.
- A "Start blank" tenant can define their own categories/genders/brands in Settings, then use the full POS flow.
- Postgres is the only database. `firebase` is not in `package.json`.
- The tenant-isolation test passes in CI.
- `npm run dev` works on a fresh clone in under 5 minutes (docker up, npm install, db:migrate, dev).
- The cream/gold theme, Cairo font, RTL layout, and `globals.css` token block are byte-for-byte unchanged.
