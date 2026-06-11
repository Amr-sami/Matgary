# Platform Admin — Spec 04: Platform plan editor

Owner: Amr · Drafted: 2026-06-10 · Depends on: **Spec 01**.

`/admin/plans` becomes a CMS for the three landing-page plans. Price
edits, copy edits, and feature-bullet edits go live within ~60 s
without a deploy. `lib/payments/plans.ts` stays as a typed fallback
used only when the DB is unreachable.

[master]: ./platform-admin-dashboard.md

---

## 1. Goal

- Super-admin opens `/admin/plans` → sees three editable cards (trial,
  professional, multi_branch).
- Edits AR label, EN label, AR tagline, EN tagline, price, purchasable
  toggle, and bullet features (per locale).
- Saves → `platform_plans` row updated → audit row written → landing
  page and `/billing` reflect the change within 60 s.
- A preview pane underneath each card shows the live landing rendering
  of the edits before the admin saves.

---

## 2. Data — no new migrations

`platform_plans` already exists from Spec 01, seeded with the three
rows. Columns recap:

```
key text PK, label_ar, label_en, tagline_ar, tagline_en,
monthly_egp int, purchasable bool,
features_ar text[], features_en text[],
sort_order int, updated_at, updated_by_admin_id
```

No new columns. No new tables. (This is the smallest spec data-wise.)

---

## 3. Runtime source swap

### 3.1 Public read endpoint

New public route `GET /api/plans`:

- No auth.
- Returns `{ data: PlatformPlan[] }` ordered by `sort_order`.
- Cached at the edge for 60 s (`s-maxage=60, stale-while-revalidate=120`).
- On DB error → fallback to `lib/payments/plans.ts` typed defaults so
  the landing page is **never** blank.

### 3.2 Consumers

The two places that currently import `PLANS` directly:

- `app/billing/page.tsx` — switched to fetch `/api/plans` client-side.
- Landing page plan cards (`app/(public)/*` / `app/page.tsx`) — switched
  to `await fetch(/api/plans, { next: { revalidate: 60 } })` server-side.

`lib/payments/plans.ts` shrinks to just `PlanKey` + `PlanDefinition`
types + a `FALLBACK_PLANS` const used by `/api/plans` when the DB
SELECT throws. No business code reads `PLANS` directly anymore.

---

## 4. Admin API surface

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/admin/plans` | any admin | All rows, with `updated_at` + last editor. |
| `PATCH` | `/api/admin/plans/[key]` | super_admin | partial update. |

Patch payload:

```ts
{
  labelAr?: string;        // 1..80
  labelEn?: string;        // 1..80
  taglineAr?: string;      // 1..200
  taglineEn?: string;      // 1..200
  monthlyEgp?: number;     // int 0..99999
  purchasable?: boolean;
  featuresAr?: string[];   // 0..15 items, each 1..200
  featuresEn?: string[];   // 0..15 items, each 1..200
  sortOrder?: number;      // 0..999
}
```

Server validates each field; rejects partial Arabic-only updates (must
send both locales when editing a label or feature list to avoid drift).

Audit before/after captures the whole row jsonb. UI surfaces a per-field
diff using a generic JSON-diff helper in Spec 08.

---

## 5. UI — `/admin/plans`

### 5.1 Layout

Three cards, one per plan, stacked. Each card has:

- **Read header**: key (e.g. `professional`) + last-updated relative +
  last editor.
- **Inline form**:
  - Two-column AR/EN label inputs.
  - Two-column AR/EN tagline inputs.
  - Price input + EGP/month suffix.
  - Purchasable toggle (with note: "if off, this plan still shows on
    landing page with a 'Coming soon' badge").
  - Sort order input.
  - **Features editor** — two columns AR + EN. Each column is a vertical
    list with:
    - Drag handle (`react-beautiful-dnd` or similar — already in repo if
      tasks UI uses it; otherwise simple ↑↓ buttons).
    - Inline edit per row.
    - Add row / Delete row.
- **Preview pane** below — renders what the landing page card would
  look like with the unsaved edits, side by side AR + EN.

### 5.2 Save flow

Save button per card. Disabled until something is dirty + valid.

On save:

1. Optimistic UI swap.
2. PATCH to `/api/admin/plans/[key]`.
3. On success → audit toast "saved · effective on landing within 60s".
4. On failure → revert + error toast with the server's message.

### 5.3 Diff confirmation modal

For non-trivial changes (price, purchasable toggle, label change), a
confirmation modal lists the diff before the PATCH fires:

```
You are changing:
  monthlyEgp: 299 → 349
  labelEn: "Professional" → "Pro"

This will be visible on the landing page within 60 seconds.
[Cancel] [Confirm]
```

Reduces "oh shit" moments.

---

## 6. Edge cases

| Scenario | Behavior |
| --- | --- |
| Admin edits price → existing paying tenant's invoice | Existing `subscriptions.amount_egp` is frozen at signup. The new price applies to new signups + renewals after `currentPeriodEndsAt`. |
| Admin sets `purchasable=false` on the only purchasable plan | Confirmation modal warns; not blocked. |
| AR feature list has 3 items, EN has 5 | Allowed in storage but the UI shows a yellow "feature lists out of sync" warning. |
| DB is down → landing page hits `/api/plans` | Fallback to `FALLBACK_PLANS` typed defaults. Logged. |
| Concurrent edit by two admins | PATCH uses optimistic locking via `updated_at` `If-Match` header. Second writer gets 409 `STALE`. |
| Admin pastes 10KB of feature text | Per-feature cap 200 chars; reject 400 with offending row index. |
| Price drops to 0 | Allowed, but a confirmation modal asks "Are you making this plan free?". |

---

## 7. Test plan

### Unit
- PATCH validator on each field shape.
- AR/EN paired requirement (sending AR-only label rejected).
- `FALLBACK_PLANS` shape matches the typed `PlanDefinition`.

### Integration
- Edit Professional price 299 → 349, fetch `/api/plans`, assert.
- Concurrent PATCH with stale `If-Match` returns 409.
- DB outage simulation → `/api/plans` still returns the fallback.

### Playwright
- Admin edits the Professional plan tagline (EN), confirms diff modal,
  saves, opens `/billing` in another tab → sees the new tagline within
  90 s.

---

## 8. Acceptance criteria

- [ ] Editing a plan never requires a deploy.
- [ ] Landing page + `/billing` both read from `/api/plans`, not from
      `lib/payments/plans.ts`.
- [ ] Every PATCH writes an audit row with a precise diff jsonb.
- [ ] `If-Match` enforcement prevents lost updates.
- [ ] If the DB is down, the landing page still renders the three plans
      from the typed fallback (verified manually by stopping postgres
      and reloading).

---

## 9. Files this spec produces

```
lib/admin/plans.ts                            (repo: get/list/patch)
lib/payments/plans.ts                         (shrinks to types + FALLBACK_PLANS)

app/api/plans/route.ts                        (public read; cached)
app/api/admin/plans/route.ts                  (GET list)
app/api/admin/plans/[key]/route.ts            (PATCH)

app/admin/plans/page.tsx
components/admin/PlanEditorCard.tsx
components/admin/PlanPreviewPane.tsx
components/admin/PlanDiffConfirmModal.tsx
components/admin/FeaturesListEditor.tsx

(landing page wires to /api/plans — file paths depend on existing routes)
app/billing/page.tsx                           (swap PLANS import → fetch)

dictionaries/ar.json + en.json                 (admin.plans.*)
```
