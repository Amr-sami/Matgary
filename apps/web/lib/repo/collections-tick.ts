// Digital collections — the `collections-tick` cron runner
// (mobile-dev-docs/15-digital-collections/13-notifications-alerts-reports.md
// §4.10; 03 §B.7). Called every 15 minutes by POST /api/cron/collections-tick.
//
// M1 jobs (13-B): `staleSweep` (grouped stale alerts, D13-1) and `limitSweep`
// (wallet limit warnings, durable dedupe D13-3). The M2 jobs of 13-C
// (`silentSourceSweep`, `rawPurge`, `lateRematch`) are added with spec 07 —
// their repo functions do not exist at M1.
//
// Rules kept here:
//   - `tenants` has no RLS, so the tenant list is read with the plain `db`
//     (digest-tick does the same); every other query runs in `withTenant`.
//   - raw `sql` never receives a JS Date: timestamps travel as ISO text with
//     `::timestamptz` (the 874d358 mark-all-paid bug, doc 14 §10.1 M6).
//   - each job of each tenant sits in its own try/catch: one failure is
//     logged + counted and the next job still runs.
//   - a rotating cursor (Redis, 1 day) makes a truncated tick resume where it
//     stopped, so no tenant is starved at the end of the list (13 §8 R4).

import { asc, inArray, sql } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { tenants } from "@/lib/db/schema";
import { cacheGet, cacheSet, globalKey } from "@/lib/cache";
import { logger } from "@/lib/logger";
import { collectionsTenantAdmitted } from "@/lib/collections/flags";
import { fanoutEvent, type CollectionLimitWarning } from "@/lib/notifications/dispatch";
import { insertCollectionEvent } from "@/lib/repo/collections";
import { limitWarnings, WALLET_LIMITS } from "@matgary/domain/collections/limits";
import { accountMask } from "@matgary/domain/collections/normalize";
import { COLLECTION_PROVIDERS } from "@matgary/domain/collections/providers";
import type { CollectionProvider, LimitWarning } from "@matgary/domain/collections/types";

export const TICK_CONSTANTS = {
  BUDGET_MS: 50_000, // stop starting new tenants after this; a */15 tick never overlaps the next
  STALE_CLAIM_LIMIT: 500, // per tenant per tick
  SILENT_MIN_MISSED: 3,
  SILENT_MIN_MISSED_DISCONNECTED: 1,
  SILENT_GRACE_MIN: 30,
  SILENT_AFTER_LAST_MIN: 10,
  RAW_PURGE_LIMIT: 5000, // 07's default
  REMATCH_MAX_AGE_H: 72, // = MATCH_CONSTANTS.SUGGEST_AFTER_H (03 §C.8)
  REMATCH_LIMIT: 200,
  BALANCE_WARN_REPEAT_H: 24,
} as const;

/** The tenant row the sweeps receive (read once per tick, no RLS). */
export interface TickTenant {
  id: string;
  timezone: string;
  suspendedAt: Date | null;
  deletionScheduledAt: Date | null;
  isDemo: boolean;
}

export interface StaleSweepResult {
  collections: number;
  notifications: number;
}

export interface LimitSweepResult {
  accounts: number;
  notifications: number;
}

export interface TickResult {
  tenants: { total: number; processed: number };
  /** true when BUDGET_MS stopped the loop before every tenant was visited. */
  truncated: boolean;
  ms: number;
  staleSweep: StaleSweepResult;
  limitSweep: LimitSweepResult;
  /** Jobs that threw (each logged as cron.collections_tick.job_failed). */
  failures: number;
}

/** The M1 jobs; overridable in tests only (13 §7 T3 "a thrown job"). */
export interface TickJobs {
  staleSweep: (t: TickTenant, now: Date) => Promise<StaleSweepResult>;
  limitSweep: (t: TickTenant, now: Date) => Promise<LimitSweepResult>;
}

export interface RunTickOptions {
  now: Date;
  /** Defaults to TICK_CONSTANTS.BUDGET_MS. */
  budgetMs?: number;
  /** Restrict the run to these tenants (tests; a manual re-run for one shop). */
  tenantIds?: readonly string[];
  /** Test seam: replace a job implementation. */
  jobs?: Partial<TickJobs>;
}

export const TICK_CURSOR_KEY = globalKey("cron", "collections-tick", "cursor");
const CURSOR_TTL_SEC = 24 * 60 * 60;

function rows<T>(res: unknown): T[] {
  return res as T[];
}

/** Integer piasters from a numeric column's text. */
function piasters(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** D13-6: demo, suspended or to-be-deleted tenants get no alerts. */
export function tenantGetsAlerts(t: TickTenant): boolean {
  return !t.isDemo && !t.suspendedAt && !t.deletionScheduledAt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

export async function runCollectionsTick(opts: RunTickOptions): Promise<TickResult> {
  const start = Date.now();
  const budget = opts.budgetMs ?? TICK_CONSTANTS.BUDGET_MS;
  const jobs: TickJobs = { staleSweep, limitSweep, ...opts.jobs };

  const all = await db
    .select({
      id: tenants.id,
      timezone: tenants.timezone,
      suspendedAt: tenants.suspendedAt,
      deletionScheduledAt: tenants.deletionScheduledAt,
      isDemo: tenants.isDemo,
    })
    .from(tenants)
    .where(opts.tenantIds ? inArray(tenants.id, [...opts.tenantIds]) : undefined)
    .orderBy(asc(tenants.id));

  const result: TickResult = {
    tenants: { total: all.length, processed: 0 },
    truncated: false,
    ms: 0,
    staleSweep: { collections: 0, notifications: 0 },
    limitSweep: { accounts: 0, notifications: 0 },
    failures: 0,
  };
  if (all.length === 0) {
    result.ms = Date.now() - start;
    return result;
  }

  // Start at the first tenant whose id is ≥ the saved cursor, wrapping
  // around; a missing (or past-the-end) cursor starts at 0.
  const cursor = await cacheGet<string>(TICK_CURSOR_KEY);
  let startIndex = 0;
  if (cursor) {
    const i = all.findIndex((t) => t.id >= cursor);
    startIndex = i < 0 ? 0 : i;
  }

  const runJob = async <R>(t: TickTenant, job: string, fn: () => Promise<R>): Promise<R | null> => {
    try {
      return await fn();
    } catch (err) {
      result.failures += 1;
      logger.error({
        event: "cron.collections_tick.job_failed",
        tenantId: t.id,
        job,
        reason: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  for (let k = 0; k < all.length; k++) {
    if (Date.now() - start >= budget) {
      result.truncated = true;
      break;
    }
    const t = all[(startIndex + k) % all.length]!;
    result.tenants.processed += 1;

    // (M2: rawPurge runs here for EVERY tenant, whatever the flags — Q14.)

    if (collectionsTenantAdmitted(t.id) && tenantGetsAlerts(t)) {
      const s = await runJob(t, "staleSweep", () => jobs.staleSweep(t, opts.now));
      if (s) {
        result.staleSweep.collections += s.collections;
        result.staleSweep.notifications += s.notifications;
      }
      const l = await runJob(t, "limitSweep", () => jobs.limitSweep(t, opts.now));
      if (l) {
        result.limitSweep.accounts += l.accounts;
        result.limitSweep.notifications += l.notifications;
      }
      // (M2: silentSourceSweep + lateRematch, also behind COLLECTIONS_INGEST_ENABLED.)
    }
  }

  const next = all[(startIndex + result.tenants.processed) % all.length]!;
  await cacheSet(TICK_CURSOR_KEY, next.id, CURSOR_TTL_SEC);

  result.ms = Date.now() - start;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// staleSweep — one grouped alert per (tenant, branch) per sweep (D13-1)
// ─────────────────────────────────────────────────────────────────────────────

export async function staleSweep(t: TickTenant, now: Date): Promise<StaleSweepResult> {
  const nowIso = now.toISOString();
  const claimed = await withTenant(t.id, async (tx) => {
    // Atomic claim: `skip locked` + `stale_notified_at is null` means two
    // overlapping ticks can never alert the same item twice (13 §8 R5).
    // A branch whose switch is off never alerts (the inner join).
    const got = rows<{ id: string; branch_id: string; amount: string; stale_after: number }>(
      await tx.execute(sql`
        WITH due AS (
          SELECT c.id, s.collections_stale_after_minutes AS stale_after
            FROM collections c
            JOIN shop_settings s
              ON s.tenant_id = c.tenant_id AND s.branch_id = c.branch_id AND s.collections_enabled
           WHERE c.tenant_id = ${t.id}
             AND c.status = 'pending'
             AND c.stale_notified_at IS NULL
             AND c.rung_at < ${nowIso}::timestamptz - make_interval(mins => s.collections_stale_after_minutes)
           ORDER BY c.rung_at
           LIMIT ${TICK_CONSTANTS.STALE_CLAIM_LIMIT}
           FOR UPDATE OF c SKIP LOCKED
        )
        UPDATE collections c
           SET stale_notified_at = now(), updated_at = now()
          FROM due
         WHERE c.id = due.id
        RETURNING c.id, c.branch_id, c.amount::text AS amount, due.stale_after
      `),
    );
    for (const r of got) {
      await insertCollectionEvent(tx, {
        tenantId: t.id,
        collectionId: r.id,
        kind: "stale_alerted",
        fromStatus: "pending",
        toStatus: "pending",
        actorUserId: null,
        details: { staleAfterMinutes: Number(r.stale_after) },
      });
    }
    return got;
  });
  if (claimed.length === 0) return { collections: 0, notifications: 0 };

  // Group by branch after commit.
  const byBranch = new Map<string, { count: number; pt: number; staleAfter: number }>();
  for (const r of claimed) {
    const g = byBranch.get(r.branch_id) ?? { count: 0, pt: 0, staleAfter: Number(r.stale_after) };
    g.count += 1;
    g.pt += piasters(r.amount);
    byBranch.set(r.branch_id, g);
  }
  const branchIds = [...byBranch.keys()];
  const names = await withTenant(t.id, async (tx) =>
    rows<{ id: string; name: string | null }>(
      await tx.execute(sql`
        SELECT b.id, b.name FROM branches b
         WHERE b.tenant_id = ${t.id}
           AND b.id IN (${sql.join(branchIds.map((id) => sql`${id}`), sql`, `)})
      `),
    ),
  );
  const nameById = new Map(names.map((n) => [n.id, n.name] as const));

  let notifications = 0;
  for (const [branchId, g] of byBranch) {
    await fanoutEvent(t.id, branchId, "collection.stale", {
      branchName: nameById.get(branchId) ?? null,
      count: g.count,
      amountEgp: g.pt / 100,
      staleAfterMinutes: g.staleAfter,
    });
    notifications += 1;
  }
  return { collections: claimed.length, notifications };
}

// ─────────────────────────────────────────────────────────────────────────────
// limitSweep — wallet limit warnings, durable per-period dedupe (D13-3)
// ─────────────────────────────────────────────────────────────────────────────

interface WalletAccountRow {
  id: string;
  branch_id: string | null;
  provider: string;
  label: string;
  wallet_opened_on: string | null;
  balance_baseline: string | null;
  account_last4: string | null;
  wallet_msisdn: string | null;
  ipa_handle: string | null;
  is_prepaid_card: boolean;
}

/** The limit a warning is measured against (EGP), or null when unknown. */
export function limitFor(warning: LimitWarning, provider: CollectionProvider): number | null {
  switch (warning) {
    case "day_80":
      return WALLET_LIMITS.individual.dayMax;
    case "month_80":
      return WALLET_LIMITS.individual.monthMax;
    case "new_wallet_day_80":
      return WALLET_LIMITS.newWallet.dayMax;
    case "balance_90":
      return COLLECTION_PROVIDERS[provider]?.balanceCap ?? null;
  }
}

/** D13-3: the limit-warning link doubles as the dedupe key (clients ignore the extra query). */
export function limitWarningLink(accountId: string, warning: LimitWarning): string {
  return `/collections?tab=totals&account=${accountId}&warning=${warning}`;
}

export async function limitSweep(t: TickTenant, now: Date): Promise<LimitSweepResult> {
  const nowIso = now.toISOString();
  const plan = await withTenant(t.id, async (tx) => {
    // 1) Only when some branch of the tenant has the switch on.
    const [on] = rows<{ n: number }>(
      await tx.execute(sql`
        SELECT count(*)::int AS n FROM shop_settings
         WHERE tenant_id = ${t.id} AND collections_enabled
      `),
    );
    if (!on || Number(on.n) === 0) return null;

    // 2) Active wallet accounts (InstaPay never warns: receiving is unlimited).
    const accounts = rows<WalletAccountRow>(
      await tx.execute(sql`
        SELECT id, branch_id, provider, label, to_char(wallet_opened_on, 'YYYY-MM-DD') AS wallet_opened_on,
               balance_baseline::text AS balance_baseline, account_last4, wallet_msisdn, ipa_handle,
               is_prepaid_card
          FROM collection_accounts
         WHERE tenant_id = ${t.id} AND rail = 'wallet' AND archived_at IS NULL
         ORDER BY sort_order, created_at, id
      `),
    );
    if (accounts.length === 0) return { accounts, bounds: null, sums: [] };

    // 3) Tenant-local bounds (digest.ts:70-94 pattern), all as ISO text.
    const [bounds] = rows<{ business_date: string; day_start: string; day_end: string; month_start: string }>(
      await tx.execute(sql`
        WITH t AS (SELECT COALESCE((SELECT timezone FROM tenants WHERE id = ${t.id}), 'Africa/Cairo') AS tz),
             d AS (SELECT (${nowIso}::timestamptz AT TIME ZONE (SELECT tz FROM t))::date AS day)
        SELECT to_char(d.day, 'YYYY-MM-DD') AS business_date,
               to_json((d.day::timestamp AT TIME ZONE t.tz)) #>> '{}' AS day_start,
               to_json(((d.day + 1)::timestamp AT TIME ZONE t.tz)) #>> '{}' AS day_end,
               to_json((date_trunc('month', d.day)::timestamp AT TIME ZONE t.tz)) #>> '{}' AS month_start
          FROM d, t
      `),
    );

    // 4) Day / month received per account: pending + confirmed + auto (06 §4.5).
    //    Void and rejected parts are money that never arrived.
    const sums = rows<{ account_id: string; day: string; month: string }>(
      await tx.execute(sql`
        SELECT c.collection_account_id AS account_id,
               COALESCE(sum(c.amount) FILTER (WHERE c.rung_at >= ${bounds!.day_start}::timestamptz), 0)::text AS day,
               COALESCE(sum(c.amount), 0)::text AS month
          FROM collections c
         WHERE c.tenant_id = ${t.id}
           AND c.collection_account_id IN (${sql.join(accounts.map((a) => sql`${a.id}`), sql`, `)})
           AND c.status IN ('pending', 'confirmed', 'auto_confirmed')
           AND c.rung_at >= ${bounds!.month_start}::timestamptz
           AND c.rung_at < ${bounds!.day_end}::timestamptz
         GROUP BY c.collection_account_id
      `),
    );
    return { accounts, bounds: bounds!, sums };
  });
  if (!plan || !plan.bounds) return { accounts: plan?.accounts.length ?? 0, notifications: 0 };

  const sumById = new Map(plan.sums.map((s) => [s.account_id, s] as const));
  const dayAgoIso = new Date(now.getTime() - TICK_CONSTANTS.BALANCE_WARN_REPEAT_H * 3_600_000).toISOString();
  let notifications = 0;

  for (const a of plan.accounts) {
    const s = sumById.get(a.id);
    const provider = a.provider as CollectionProvider;
    let warnings: LimitWarning[];
    try {
      warnings = limitWarnings({
        rail: "wallet",
        provider,
        date: plan.bounds.business_date,
        walletOpenedOn: a.wallet_opened_on,
        dayReceived: s?.day ?? "0",
        monthReceived: s?.month ?? "0",
        balance: a.balance_baseline,
      });
    } catch (err) {
      logger.warn({
        event: "cron.collections_tick.limit_input_invalid",
        tenantId: t.id,
        accountId: a.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const w of warnings) {
      const link = limitWarningLink(a.id, w);
      const periodStart =
        w === "month_80" ? plan.bounds.month_start : w === "balance_90" ? dayAgoIso : plan.bounds.day_start;
      const seen = await withTenant(t.id, async (tx) =>
        rows<{ one: number }>(
          await tx.execute(sql`
            SELECT 1 AS one FROM notifications
             WHERE tenant_id = ${t.id} AND kind = 'collection_limit' AND link = ${link}
               AND created_at >= ${periodStart}::timestamptz
             LIMIT 1
          `),
        ),
      );
      if (seen.length > 0) continue;

      const received =
        w === "month_80" ? s?.month ?? "0" : w === "balance_90" ? a.balance_baseline ?? "0" : s?.day ?? "0";
      await fanoutEvent(t.id, a.branch_id, "collection.limit_warning", {
        accountId: a.id,
        accountLabel: a.label,
        accountMask: accountMask({
          accountLast4: a.account_last4,
          walletMsisdn: a.wallet_msisdn,
          ipaHandle: a.ipa_handle,
          isPrepaidCard: a.is_prepaid_card,
        }),
        provider,
        warning: w as CollectionLimitWarning,
        receivedEgp: piasters(received) / 100,
        limitEgp: limitFor(w, provider),
        link,
      });
      notifications += 1;
    }
  }
  return { accounts: plan.accounts.length, notifications };
}
