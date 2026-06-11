# Daily Owner Digest — Spec

Owner: Amr · Drafted: 2026-06-10

A scheduled one-shot WhatsApp message at closing time, per branch,
summarising the day for the owner. Pure read-side feature — leans on
the existing WhatsApp outbound worker, the existing
`/api/cron/*` pattern, and the existing aggregate queries.

---

## 1. Goal

Owner gets one WhatsApp every evening that answers:

1. Did we have a normal sales day? (gross, vs yesterday)
2. What sold best? (top SKU)
3. Anything I need to act on tomorrow? (low stock, deferred ageing,
   attendance review flags, cash shortfalls, unread tasks)

**Acceptance** — by the end of v1:

- Every active tenant with a configured WhatsApp connection receives one
  message per branch per business day, at the configured local hour,
  exactly once.
- Re-running the cron tick is a no-op for already-sent digests.
- Owner can preview today's digest right now from settings, and
  re-send any past day's digest manually.
- Failed sends are retried up to 3× by the existing outbound worker;
  permanent failures are visible in `/settings/digest`.

---

## 2. Recipients

Per (tenant, branch), the digest is sent to:

- The tenant owner's WhatsApp number (from `users.phone` of any user with
  `role='owner'` on the tenant). Multiple owners → each gets it.
- Any extra recipients configured in `digest_settings.extra_recipients`
  (free-form name + phone).
- **Opt-in**: a branch manager (any staff with `manage_cash_reconciliation`
  permission) gets the digest for their assigned branch. Toggle per
  manager in `/settings/digest`.

Each recipient is sent the **branch-scoped** digest (one message per
branch they're attached to), never a merged "all branches" message.
Owners with N branches → N messages. Keeps each message punchy.

---

## 3. Channels

- **v1**: WhatsApp via the existing `lib/whatsapp/outbound-sender.ts`
  pipeline (cloud Graph API + on-prem Green API both supported by the
  current worker).
- **v1.1**: Email fallback. If WhatsApp send fails permanently for a
  recipient AND they have an email, fall through to a templated email.
  Logged as channel='email_fallback'.
- **v2 (out of scope)**: in-app notification bell only.

---

## 4. Schedule

Each tenant picks a single hour-of-day in their local timezone (default
**00:00** = end of day / midnight). Single column on `digest_settings`.

External scheduler hits `POST /api/cron/digest-tick` every **30 minutes**
(at :00 and :30 of every hour). The route:

1. Computes the current UTC time.
2. For every tenant with `digest_settings.enabled=true`:
   - Converts UTC → tenant.timezone (already in schema).
   - Skips unless local time is within `[digest_hour:00, digest_hour:29]`.
3. For each qualifying tenant: enqueues one job per active branch.

30-minute cadence + 30-minute window means a single tick window catches
every tenant exactly once even if cron skews by ±5 min. Lock via Redis
key `digest:tick:<utc_hour><utc_half>` (TTL 30 min) so two simultaneous
invocations don't double-send.

---

## 5. Content

For each (tenant, branch, business_date):

### 5.1 Sections in order

1. **Header** — branch name + business_date (formatted in tenant locale).
2. **Sales summary** — gross, sale count, vs same weekday last week
   (sparkline-ish percentage delta).
3. **Payment-method split** — cash / card / instapay / deferred totals.
4. **Top SKU** — best-selling product today (name, qty, revenue).
5. **Low stock** — count of SKUs at/below threshold (top 3 names).
6. **Deferred ageing** — count of unpaid deferred sales > 7 days old,
   total outstanding.
7. **Attendance review** — count of attendance events with
   `requires_review=true` created today.
8. **Cash reconciliation** — referencing the [Z-report spec][zreport]:
   - If any shift closed today with variance ≥ ₤1 → "⚠ خزينة: عجز
     ₤X في شيفت <cashier>".
   - If any shift still open at digest time → "⚠ شيفت لم يُقفل
     (<cashier>, مفتوح من <opened_at>)".
   - Else "✅ كل الشيفتات مقفولة بدون فروقات".
9. **Open tasks** — count of tasks assigned but `assignee_seen_at IS NULL`
   AND `status IN ('open','in_progress')`.

[zreport]: ./cash-reconciliation-zreport.md

### 5.2 Locale handling

- Each recipient has a preferred locale (`users.locale` — column from
  migration 0031). Messages render in that locale.
- Numbers go through `formatCurrency(locale)` + `formatNumber(locale)`.
- Dates go through `formatDate(locale)`.

### 5.3 Sample message (AR, tenant locale=ar)

```
🏪 الفرع الرئيسي · يوم 2026-06-10

💰 المبيعات: ₤14,300 (12 فاتورة)  ▲ 18 % مقارنة بالأسبوع اللي فات
   نقدًا 8,200 · فيزا 4,100 · إنستا 1,500 · آجل 500

🥇 الأعلى مبيعًا: ساعة Casio MTP (3 ×, ₤4,350)

⚠ مخزون منخفض: 4 منتجات
   • برفان Tom Ford Oud (متبقي 1)
   • نظارة Persol Vintage (متبقي 2)
   • برفان Bvlgari Aqua (متبقي 2)

⚠ آجل متأخر: 3 فواتير ₤2,300 مستحقة منذ +7 أيام
⚠ حضور: 1 شيفت محتاج مراجعة (سارة)
⚠ خزينة: عجز ₤45 في شيفت سارة

✅ مهام: لا توجد مهام جديدة بدون تأكيد

افتح اللوحة → https://matgary.app/?branch=main
```

### 5.4 Sample message (EN)

```
🏪 Main Branch · 2026-06-10

💰 Sales: EGP 14,300 (12 invoices)  ▲ 18 % vs same day last week
   Cash 8,200 · Card 4,100 · InstaPay 1,500 · Deferred 500

🥇 Top seller: Casio MTP watch (3 ×, EGP 4,350)

⚠ Low stock: 4 SKUs
   • Tom Ford Oud (1 left)
   • Persol Vintage (2 left)
   • Bvlgari Aqua (2 left)

⚠ Overdue deferred: 3 invoices, EGP 2,300 past 7 days
⚠ Attendance: 1 shift needs review (Sara)
⚠ Cash: EGP 45 short in Sara's shift

✅ Tasks: no unacknowledged tasks

Open dashboard → https://matgary.app/?branch=main
```

### 5.5 Empty-day rule

If `gross == 0 AND saleCount == 0 AND no warnings` → either skip the
send (default) or send a brief "No activity today" message. Controlled
by `digest_settings.send_on_empty` (default false).

---

## 6. Data model

### 6.1 Migration `0033_daily_digest.sql`

```sql
CREATE TABLE digest_settings (
  tenant_id              uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled                boolean NOT NULL DEFAULT false,
  -- 0 = midnight end-of-day digest. Tenant-local timezone (tenants.timezone).
  digest_hour            smallint NOT NULL DEFAULT 0
                          CHECK (digest_hour BETWEEN 0 AND 23),
  -- Primary recipient for the digest. Intentionally separate from
  -- shop_settings WhatsApp creds (which are for customer receipts) AND
  -- from tenant_members.phone (which is HR contact data).
  owner_phone            text,
  send_on_empty          boolean NOT NULL DEFAULT false,
  email_fallback         boolean NOT NULL DEFAULT true,
  extra_recipients       jsonb NOT NULL DEFAULT '[]'::jsonb,
                          -- shape: [{ name, phone?, email?, locale? }]
  managers_subscribed    uuid[] NOT NULL DEFAULT '{}',
                          -- user IDs of managers who opted in to their branch digest
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE digest_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY digest_settings_tenant_isolation ON digest_settings
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);


CREATE TABLE digest_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id             uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  business_date         date NOT NULL,
  recipient_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  recipient_phone       text,           -- denormalized; survives user delete
  recipient_email       text,
  channel               text NOT NULL
                         CHECK (channel IN ('whatsapp', 'email', 'email_fallback')),
  status                text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'sent', 'failed', 'skipped_empty', 'skipped_no_channel')),
  error                 text,
  payload               jsonb NOT NULL,    -- the computed DigestPayload (§7)
  message_text          text,             -- the rendered body, for audit + resend
  whatsapp_message_id   text,             -- provider ID once accepted
  enqueued_at           timestamptz NOT NULL DEFAULT now(),
  sent_at               timestamptz
);

CREATE INDEX digest_runs_tenant_date_idx ON digest_runs (tenant_id, business_date DESC);
CREATE INDEX digest_runs_status_idx ON digest_runs (status, enqueued_at) WHERE status = 'pending';

-- Idempotency. Composite-null-distinct lets us have multiple recipient_user_id=NULL
-- rows for an "extra recipient" by phone, but at most one row per
-- (tenant, branch, day, recipient_user_id, channel) for real users.
CREATE UNIQUE INDEX digest_runs_idempotency
  ON digest_runs (tenant_id, branch_id, business_date, recipient_user_id, channel)
  WHERE recipient_user_id IS NOT NULL;

CREATE UNIQUE INDEX digest_runs_idempotency_phone
  ON digest_runs (tenant_id, branch_id, business_date, recipient_phone, channel)
  WHERE recipient_user_id IS NULL AND recipient_phone IS NOT NULL;

ALTER TABLE digest_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY digest_runs_tenant_isolation ON digest_runs
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

`digest_settings.email_fallback` is the master switch for §3 v1.1 behaviour.

---

## 7. Aggregation

Single repo module `lib/repo/digest.ts`:

```ts
export interface DigestPayload {
  branchId: string;
  branchName: string;
  businessDate: string;          // ISO yyyy-mm-dd in tenant tz
  sales: {
    gross: string;
    count: number;
    deltaPctVsSameWeekday: number | null; // null = no comparable day
    byMethod: { cash: string; card: string; instapay: string; deferred: string };
  };
  topSku: { name: string; qty: number; revenue: string } | null;
  lowStock: {
    totalCount: number;
    top: { name: string; quantityLeft: number }[];   // up to 3
  };
  deferredOverdue: { count: number; totalOutstanding: string };
  attendanceReviewCount: number;
  cash: {
    closedShifts: number;
    shortShifts: { cashier: string; shortBy: string }[];
    openShifts: { cashier: string; openedAt: string }[];
  };
  unreadTaskCount: number;
}

export async function computeDigest(
  tenantId: string,
  branchId: string,
  businessDate: string,  // yyyy-mm-dd in tenant tz
): Promise<DigestPayload>;
```

Implementation:
- One `withTenant(tenantId, async (tx) => {...})` block.
- Each section is a single SQL query (no N+1). Together ~8 queries.
- Date math via `AT TIME ZONE tenant.tz` → fold into business_date.
- Deltas computed against `businessDate - 7` (same weekday, more
  stable than `businessDate - 1` for weekly retail patterns).
- Returns string-encoded numerics — same convention as the rest of the
  repo.

Renderer `lib/digest/render.ts`:

```ts
export function renderDigestMessage(
  payload: DigestPayload,
  opts: { locale: 'ar' | 'en'; tenantSlug: string; dashboardUrl: string },
): { text: string; previewText: string };
```

Pure function. Heavy use of the existing `formatCurrency`,
`formatNumber`, `formatDate` helpers in `lib/i18n/format.ts`.

---

## 8. Cron / scheduler

### 8.1 Endpoint `POST /api/cron/digest-tick`

Reuses the security pattern from `/api/cron/recurring-expenses`:

- Bearer token = `process.env.CRON_SECRET`, constant-time compared.
- POST only.
- Per-IP rate limit (6/h).

Body:

```ts
{
  // Optional override for backfill / replay. Default = "now()".
  forceUtcInstant?: string;
}
```

Algorithm:

1. Acquire Redis lock `digest:tick:<utc_hour>:<utc_half>` (TTL 30 min).
2. Select all tenants with `digest_settings.enabled=true`.
3. For each tenant, compute `local_time = utc_now AT TIME ZONE tenant.timezone`.
4. If `local_time.hour == digest_hour AND local_time.minute < 30`,
   enqueue. Else skip.
5. For each enqueued tenant:
   a. Compute `business_date = local_time.date`.
   b. For each active branch:
      i. Build the recipient list: `tenant_owners ∪ extra_recipients ∪
         managers_subscribed_to_this_branch`.
      ii. For each recipient × channel:
         - Idempotency check: SELECT FROM digest_runs WHERE
           (tenant, branch, business_date, recipient, channel) AND
           status IN ('sent','pending'). If found, skip.
         - Compute payload (once per branch, cached in-memory for the
           recipient loop).
         - Render message in recipient's locale.
         - INSERT digest_runs row (status='pending').
         - Enqueue WhatsApp outbound job referencing the digest_runs.id.
6. Release lock. Respond `{ ok: true, enqueued: N, skipped: M }`.

### 8.2 WhatsApp outbound integration

The existing `lib/whatsapp/outbound.ts` job processor handles delivery,
retries, and provider errors. We add one new job kind:

```ts
{ kind: 'daily_digest', digestRunId: '<uuid>' }
```

The worker:
- Reads `digest_runs` row by id under the right tenant context.
- Sends the `message_text` via Cloud / Green API per tenant's connection.
- On success: update `status='sent'`, `sent_at=now()`, `whatsapp_message_id`.
- On permanent fail with `email_fallback=true` AND recipient has email
  → insert a sibling digest_runs row `channel='email_fallback'`,
  send via existing email transport.
- On terminal fail: `status='failed'`, `error=<reason>`. Surfaces in
  `/settings/digest` warnings.

### 8.3 Sweep job

Sibling cron `POST /api/cron/digest-cleanup` — daily at 03:00 UTC:

- Delete `digest_runs` older than 90 days (audit history is plenty).
- No-op for active rows; payload column dominates table size.

---

## 9. Manual resend

`POST /api/digest/resend` body:

```ts
{
  branchId: string;            // required
  businessDate?: string;       // default = today in tenant tz
  recipientUserId?: string;    // default = caller
}
```

- Permission: `manage_cash_reconciliation` (owner-level work).
- Bypasses the schedule check (immediate).
- Still hits the idempotency unique index → if already sent, returns
  400 with code `ALREADY_SENT` and the existing digest_runs.id.
- Owner clicks **Resend** in `/settings/digest` → modal asks date +
  recipient → POSTs.

---

## 10. UI — `/settings/digest`

Sections:

1. **Toggle** — enabled/disabled with a "test now" button.
2. **Schedule** — hour picker (0-23), subtitle "your timezone (Africa/Cairo)".
3. **Empty-day behavior** — toggle send_on_empty.
4. **Channels** — email_fallback toggle.
5. **Extra recipients** — table with name + phone + email columns,
   add/edit/remove inline.
6. **Manager opt-in** — list of branch managers with checkbox to
   subscribe them to their branch's digest.
7. **Preview** — "Preview today's digest" button → renders today-so-far
   into a Modal with the WhatsApp-styled bubble.
8. **History** — last 14 days of `digest_runs` rows per branch with
   status badge, message_text expandable, **Resend** action when
   status=failed.

---

## 11. Permissions

| Permission | Default holder | Meaning |
| --- | --- | --- |
| `manage_digest_settings` | owner | Read/write `/settings/digest`. |
| `view_digest_history` | owner / branch manager | See own/branch digest runs. |

`manage_digest_settings` is a new permission. Add to
`lib/permissions.ts` catalog with a default-grant on owner.

---

## 12. Edge cases

| Scenario | Behavior |
| --- | --- |
| Tenant has no WhatsApp connection | `digest_runs` row inserted with `status='skipped_no_channel'`. `/settings/digest` shows a warning banner: "Connect WhatsApp to start receiving digests." |
| Owner has no phone in `users.phone` | Skip that recipient with `status='skipped_no_channel'`. Email fallback still works if email present + enabled. |
| Recipient phone invalid format | Outbound worker fails fast; `status='failed'`, error message includes "invalid_phone". |
| Cron tick missed (server down) | Next tick within the 30-min window catches it. Past-window misses are NOT auto-replayed — owner uses Resend. |
| Tick runs twice in same window (race) | Redis lock prevents it. If lock fails: per-recipient idempotency unique idx prevents double-send. |
| Tenant changes timezone mid-day | Digest fires on the new TZ's hour. Possible duplicate or missed digest that day — accept it (rare event). |
| Branch deactivated | Skip; no digest for inactive branches. |
| Recipient revoked their consent | Manual remove from `extra_recipients` or unsubscribe button in WhatsApp template (handled by existing opt-out infra). |
| Owner has multiple tenants | Each tenant runs independently; owner gets N digests across tenants. By design. |
| `digest_hour` set to current hour at time of toggle-on | Possible same-day fire if within the window; expected. |
| Numbers overflow (gross > 999,999,999) | `formatCurrency` handles it; layout uses single line wrap. No truncation. |
| Locale mismatch (recipient locale=en, tenant locale=ar) | Recipient wins. Branch name stays in its stored value (Arabic for Egyptian shops); other strings localized. |
| User deleted between enqueue and send | `recipient_phone` denormalized → send still works to the phone. After send, `recipient_user_id` is null on the row. |
| Computed payload is huge (>16 KB jsonb) | Top-N caps already bound size (top 3 low-stock, top 1 SKU). Safe. |

---

## 13. Activity log

- `digest.enabled` — actor=owner, action toggled on/off.
- `digest.settings_changed` — actor=owner, diff of fields.
- `digest.sent` — actor=null (system), metadata={ branchId, recipient,
  channel, businessDate }.
- `digest.failed` — actor=null, metadata={ ..., error }.

Used to audit "why didn't I get my digest?" investigations.

---

## 14. Out of scope (v1)

- Weekly / monthly digests.
- AI-generated insights ("you sold 30 % more perfumes — try restocking
  Dior?"). Punt to v2 with a separate spec.
- Configurable per-section toggle (let owner hide low-stock section etc).
- PDF attachment.
- Localised currency symbol per branch (we assume EGP everywhere v1).
- Push to Telegram / Slack / SMS.
- In-app digest archive UI separate from `/settings/digest`.

---

## 15. Test plan

### 15.1 Unit (renderer)

- `renderDigestMessage` produces stable output for a fixed payload in
  AR and EN. Snapshot tests.
- All sections render the empty-state copy when their data is zero.
- Locale formatting: numbers, currency, percent delta with sign.

### 15.2 Integration (cron + repo)

- Seed sales for `today` in tenant `samyamr819` → POST `/api/cron/digest-tick`
  with `forceUtcInstant` at tenant-local 21:15 → assert one digest_runs
  row per branch per recipient, status=pending.
- Run tick again at 21:20 → second run is no-op (idempotency).
- Run tick at 21:45 → outside window, no enqueue.
- Disable digest → tick is no-op.
- Branch with zero sales + send_on_empty=false → status='skipped_empty',
  no WhatsApp queued.
- Tenant with no WhatsApp connection → status='skipped_no_channel',
  email_fallback rows queued if applicable.

### 15.3 Computation correctness

- Delta vs same weekday: yesterday wasn't same weekday → null delta.
  Same weekday last week with known gross → expected percent.
- Top SKU returns the highest-revenue product, ties broken by qty.
- Low-stock top 3 sorted ascending by quantity, descending by velocity.

### 15.4 RLS

- Tenant A's owner cannot read tenant B's digest_runs even if they
  guess UUIDs.

### 15.5 UI (Playwright)

- Owner toggles digest on, picks 21:00 → settings persist.
- Preview button shows the actual rendered message body.
- Resend a failed run from history → new digest_runs row inserted,
  status=pending.

### 15.6 Smoke

- `/api/cron/digest-tick` rejects missing / wrong bearer.
- Rate-limit kicks in at 7th hit/hour from same IP.

---

## 16. Rollout plan

1. **Migration 0033** — empty tables.
2. **Repo + renderer** — unit-tested in isolation.
3. **Cron endpoint** + WhatsApp job kind. Wire to existing scheduler
   (docker-compose `cron` sidecar / Vercel Cron).
4. **Settings UI**.
5. **Soft launch** — flip `enabled=true` for samyamr819 tenant only;
   observe a week of digests + a manual resend cycle.
6. **Default OFF for new tenants** — opt-in via onboarding step or
   settings page. (Opt-out by default avoids surprising people who
   didn't ask to be WhatsApped at night.)

---

## 17. Open questions

- Should we send a *test* digest immediately when owner enables for the
  first time? Lean: yes, makes the "did it work?" question instant.
- Hour granularity is enough, or do we need minute precision (e.g.
  21:30)? v1: hour. Cheap to upgrade later.
- Per-channel preference per recipient (some want WhatsApp, some want
  email)? v1: each row in `extra_recipients` carries phone + email and
  the digest picks WhatsApp first. v2: explicit channel-per-recipient.
- Localise the branch name when both locales exist? v1: store and send
  whatever's in `branches.name` (single value). v2: bilingual branch
  names with locale-aware pick.
- Throttle to one digest per recipient per day even across tenants?
  Probably not — owners with multiple tenants want all of them.
