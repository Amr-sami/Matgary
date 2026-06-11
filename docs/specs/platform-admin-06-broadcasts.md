# Platform Admin — Spec 06: Platform broadcasts

Owner: Amr · Drafted: 2026-06-10 · Depends on: **Spec 01**.

Super-admin posts a short bilingual message and it appears as a banner
in every tenant's UI within ~60 s. Used for scheduled maintenance,
incidents, feature announcements.

[master]: ./platform-admin-dashboard.md

---

## 1. Goal

- Super-admin opens `/admin/broadcasts` → New → fills title AR/EN,
  body AR/EN, severity, audience, start, end → Save.
- Every tenant request server-side reads "active broadcasts" (cached
  60 s) and serializes them onto the tenant session.
- `AppShell` renders a banner stack at the top (max one critical, then
  warnings, then info).
- Tenants can dismiss a banner per browser (localStorage by broadcast
  id). Doesn't propagate across devices.
- Broadcast scoping: `all` / `owners` / `staff` audiences.

---

## 2. Data — no new migrations

`platform_broadcasts` already exists from Spec 01. Columns recap:

```
id, title_ar, title_en, body_ar, body_en,
severity ('info'|'warning'|'critical'),
audience ('all'|'owners'|'staff'),
starts_at, ends_at, created_at, created_by_admin_id
```

No schema additions.

---

## 3. Repo layer

`lib/admin/broadcasts.ts`:

```ts
export async function listAllBroadcasts(): Promise<BroadcastListRow[]>;

export interface CreateBroadcastInput {
  titleAr: string;
  titleEn: string;
  bodyAr?: string | null;
  bodyEn?: string | null;
  severity: 'info' | 'warning' | 'critical';
  audience: 'all' | 'owners' | 'staff';
  startsAt: Date;
  endsAt?: Date | null;
}

export async function createBroadcast(adminId: string, input: CreateBroadcastInput, meta): Promise<{ id: string }>;

export async function patchBroadcast(adminId: string, id: string, patch: Partial<CreateBroadcastInput>, meta): Promise<void>;

export async function endBroadcastEarly(adminId: string, id: string, meta): Promise<void>;
```

Public read (used by tenants):

```ts
// in lib/broadcasts.ts (NOT lib/admin/*) — tenant-safe.
export async function getActiveBroadcasts(now: Date, role: 'owner' | 'staff'): Promise<PublicBroadcast[]>;
```

Implementation note: the tenant read uses the **tenant** DB pool. The
`platform_broadcasts` table is granted SELECT to `matgary_app` (RLS not
needed — the table has no tenant-id; every tenant sees the same global
broadcasts).

---

## 4. API surface

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/admin/broadcasts` | any admin | All broadcasts incl. past. |
| `POST` | `/api/admin/broadcasts` | super_admin | body = CreateBroadcastInput |
| `PATCH` | `/api/admin/broadcasts/[id]` | super_admin | partial |
| `POST` | `/api/admin/broadcasts/[id]/end-now` | super_admin | sets ends_at = now() |
| `GET` | `/api/broadcasts` | public (cached 60s) | Only active broadcasts; filtered by audience inferred from auth |

The public route reads the caller's session role and returns only the
broadcasts whose audience applies. Server-rendered into `AppShell`'s
banner stack.

---

## 5. UI

### 5.1 `/admin/broadcasts`

- "New broadcast" button at top.
- **Active** section — broadcasts whose `starts_at ≤ now < ends_at OR ends_at IS NULL`. Each has:
  - severity badge, audience badge.
  - title + body preview.
  - "Ends in …" or "No end set".
  - Actions: Edit · End now.
- **Scheduled** section — `starts_at > now`. Same shape + "Starts in …".
- **Past** section (collapsed by default) — `ends_at < now`.

### 5.2 New / edit form

Two-column AR + EN inputs:

- Title (required both locales, 1-120).
- Body (optional, 0-1000 each).
- Severity radio: info / warning / critical (visual preview of color).
- Audience radio: all / owners / staff.
- Start: datetime, defaults to "now".
- End: datetime, optional. If left empty, broadcast stays forever (a
  loud yellow hint reads "no end set — make sure you remember to end
  it manually").

### 5.3 Tenant-side `BroadcastStack` component

Mounted in `AppShell` between the topbar and the page content. Renders
at most one **critical** banner at top, then up to two warnings, then
up to two info. Each:

- Severity-colored background (critical red, warning orange, info
  neutral).
- Title (bold) + body (smaller).
- "Dismiss" × button (writes `localStorage[broadcast:dismissed:<id>] = 1`).
- Pre-translated copy based on the user's `users.locale`.

### 5.4 Dismissal behavior

- localStorage scope: per-browser, per-user-id (key suffix). Cleared on
  full sign-out.
- A broadcast's `id` never changes; if a critical incident requires
  re-showing a dismissed banner, super-admin creates a new broadcast
  (different id) — that's the explicit "make sure they see this"
  escape hatch.

---

## 6. Edge cases

| Scenario | Behavior |
| --- | --- |
| `starts_at > ends_at` | 400 `INVALID_WINDOW`. |
| Body very long (1KB) | Accepted up to 1000 chars; client warns over 500. |
| No active broadcasts | `BroadcastStack` renders nothing. |
| Tenant user with `users.locale=ar` reads broadcast that has only EN title | UI falls back to EN with a small "(EN)" tag. Saving a broadcast without both languages is allowed but the form warns. |
| Critical broadcast posted while a user is on the page | They see it within their next session-callback refresh (≤30 s) or when they navigate. |
| Multiple critical broadcasts active | UI shows the most recent only; the others render in the topbar bell as "1 more critical" link. |
| Audience filter mismatch | Owner-only broadcast not visible to staff signed-in users. |

---

## 7. Test plan

### Unit
- Active filter at boundary times (exactly `now`, ±1 s).
- Audience filter matrix (owner sees `all`+`owners`; staff sees `all`+`staff`).
- Window validator.

### Integration
- Post a broadcast → GET `/api/broadcasts` as tenant returns it within
  the 60 s cache window.
- Edit a broadcast → cache invalidates on next read.
- End-now sets `ends_at` and the broadcast disappears from public
  fetch.

### Playwright
- Admin posts a critical broadcast → opens tenant in incognito → sees
  the red banner on `/dashboard` within 90 s.
- User dismisses → banner gone on this browser. Open another browser
  → banner still there.

---

## 8. Acceptance criteria

- [ ] Public `/api/broadcasts` returns only currently-active broadcasts
      matching the caller's role.
- [ ] `BroadcastStack` renders correct severity + AR/EN copy.
- [ ] Dismissal persists per-browser per-user, doesn't leak across
      users.
- [ ] Admin can't save a broadcast with `ends_at < starts_at`.
- [ ] Every create / patch / end-now writes an audit row.

---

## 9. Files this spec produces

```
lib/admin/broadcasts.ts                       (admin-side writes)
lib/broadcasts.ts                             (tenant-side public read)

app/api/admin/broadcasts/route.ts
app/api/admin/broadcasts/[id]/route.ts
app/api/admin/broadcasts/[id]/end-now/route.ts
app/api/broadcasts/route.ts                   (public, cached)

app/admin/broadcasts/page.tsx
components/admin/BroadcastEditor.tsx
components/admin/BroadcastListSection.tsx

components/broadcasts/BroadcastStack.tsx      (tenant-side)
components/layout/AppShell.tsx                (mounts BroadcastStack)

dictionaries/ar.json + en.json                (admin.broadcasts.*, broadcast.severity.*)
```
