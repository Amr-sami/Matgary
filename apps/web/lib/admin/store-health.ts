// Store Health + Risk service. Phase 1 of the Platform Admin Command Center.
//
// Two orthogonal readings of the same signals:
//
//   HEALTH  → "How well is this store doing right now?" 0..100 score,
//             weighted across activity / sales / employees / recent-activity /
//             subscription / existing-health-flags. Rolled up to a status
//             (healthy / attention / at_risk).
//
//   RISK    → "Should someone from customer success call this owner?"
//             Deterministic rules fed by the same signals; each matched rule
//             contributes a weight; the summed weight picks a level
//             (healthy / low / medium / high).
//
// Why two numbers for similar data: the Health score answers the owner's
// question ("am I using the product well"), the Risk level answers ours
// ("are we about to lose this customer"). They move together on healthy
// stores, but a suspended/payment-failure tenant is HIGH risk even if the
// store was actively used right up to the suspension — and that's the
// ordering the attention panel needs.
//
// Architecture
// ────────────
//  1. Data-gathering (gatherStoreSignals) is batched — one query per signal
//     over N tenants, grouped by tenant_id. Scales linearly in tenants-per-
//     page, not in queries.
//  2. Scoring (scoreHealth + scoreRisk) is a pure function over the gathered
//     signals → trivially unit-testable with synthetic rows.
//  3. The repo returns i18n KEYS and param maps, not localized strings. The
//     API passes them through; the UI translates. Keeps the backend
//     locale-agnostic and makes the reasons searchable/filterable later.
//
// No branches: every query reads tenant-level signals (sales by tenant_id,
// activity_logs by tenant_id, subscriptions, tenants). No branchId.
// No activity-logs-by-branch, no branch comparison, no branch filter.

import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import {
  activityLogs,
  paymentAttempts,
  sales,
  subscriptions,
  tenantMembers,
  tenants,
} from "@/lib/db/schema";
import { getAdminDb } from "./db";
import { computeHealthFlags, type HealthFlag } from "./health-flags";

// ── Public types ────────────────────────────────────────────────────────────

export type HealthStatus = "healthy" | "attention" | "at_risk";
export type RiskLevel = "healthy" | "low" | "medium" | "high";

export interface HealthCategory {
  key:
    | "activity"
    | "sales"
    | "employees"
    | "recent_activity"
    | "subscription"
    | "flags";
  score: number;
  max: number;
}

/**
 * A single reason for a score or risk. `key` is an i18n path the UI resolves.
 * `params` carries the measured values so the translation can interpolate.
 * The backend NEVER returns pre-translated strings.
 */
export interface Reason {
  key: string;
  params?: Record<string, string | number>;
}

export interface StoreHealth {
  score: number;
  status: HealthStatus;
  categories: HealthCategory[];
  reasons: Reason[];
}

export interface StoreRisk {
  level: RiskLevel;
  score: number;
  reasons: Reason[];
}

// ── Signal gathering (batched over many tenants) ────────────────────────────

/** One tenant's measurable data, fed into the pure scoring functions. */
export interface TenantSignals {
  tenantId: string;
  createdAt: Date;
  suspendedAt: Date | null;
  /** Subscription row fields, or null when none exists yet. */
  subscription: {
    status: string;
    trialEndsAt: Date;
    cancelledAt: Date | null;
  } | null;
  /** Count of employees (tenant_members rows). */
  employeeTotal: number;
  /** Employees who have any activity_logs row in the last 30 days. */
  employeeActiveLast30d: number;
  /** Last activity timestamp across any user in this tenant. */
  lastActivityAt: Date | null;
  /** Last sale — null if never. */
  lastSaleAt: Date | null;
  /** Sum of sales total in the last 30 days (number, EGP). */
  salesLast30d: number;
  /** Sum of sales total in the preceding 30d window (i.e. 30..60d ago). */
  salesPrev30d: number;
  /** Number of failed payments in the last 30 days. */
  paymentFailuresLast30d: number;
  /** Pre-existing flags (digest_not_configured, no_sales_7d, dormant_employees_30d). */
  flags: HealthFlag[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / MS_PER_DAY);
}

function toIso(d: Date): string {
  return d.toISOString();
}

/** Batched signal gather for N tenants. One query per signal, each grouped
 *  by tenant_id so the result is linear in tenants but constant in query
 *  count. Callers that need health-flags can compute them separately
 *  (per-tenant) since they already exist in `health-flags.ts`. */
export async function gatherStoreSignals(
  tenantIds: string[],
): Promise<Map<string, TenantSignals>> {
  const out = new Map<string, TenantSignals>();
  if (tenantIds.length === 0) return out;
  const db = getAdminDb();
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * MS_PER_DAY);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * MS_PER_DAY);

  const [
    tenantRows,
    subscriptionRows,
    employeeTotals,
    employeeActive,
    lastActivity,
    lastSale,
    sales30,
    salesPrev30,
    paymentFailures,
  ] = await Promise.all([
    db
      .select({
        id: tenants.id,
        createdAt: tenants.createdAt,
        suspendedAt: tenants.suspendedAt,
      })
      .from(tenants)
      .where(inArray(tenants.id, tenantIds)),

    db
      .select({
        tenantId: subscriptions.tenantId,
        status: subscriptions.status,
        trialEndsAt: subscriptions.trialEndsAt,
        cancelledAt: subscriptions.cancelledAt,
      })
      .from(subscriptions)
      .where(inArray(subscriptions.tenantId, tenantIds)),

    db
      .select({
        tenantId: tenantMembers.tenantId,
        count: sql<number>`count(distinct ${tenantMembers.userId})::int`,
      })
      .from(tenantMembers)
      .where(inArray(tenantMembers.tenantId, tenantIds))
      .groupBy(tenantMembers.tenantId),

    // "Active employees" = distinct user_id with an activity_logs row in
    // the last 30 days. NOT EXISTS over activity_logs would be cleaner but
    // this version joins because we also want the count for later features.
    db.execute(sql`
      SELECT tm.tenant_id::text AS tenant_id,
             count(distinct tm.user_id)::int AS count
      FROM tenant_members tm
      WHERE tm.tenant_id IN (${sql.join(
        tenantIds.map((x) => sql`${x}::uuid`),
        sql`, `,
      )})
        AND EXISTS (
          SELECT 1 FROM activity_logs al
          WHERE al.actor_user_id = tm.user_id
            AND al.tenant_id = tm.tenant_id
            AND al.created_at > ${toIso(thirtyDaysAgo)}::timestamptz
        )
      GROUP BY tm.tenant_id
    `),

    db
      .select({
        tenantId: activityLogs.tenantId,
        lastAt: sql<Date | null>`max(${activityLogs.createdAt})`,
      })
      .from(activityLogs)
      .where(inArray(activityLogs.tenantId, tenantIds))
      .groupBy(activityLogs.tenantId),

    db
      .select({
        tenantId: sales.tenantId,
        lastAt: sql<Date | null>`max(${sales.saleDate})`,
      })
      .from(sales)
      .where(inArray(sales.tenantId, tenantIds))
      .groupBy(sales.tenantId),

    db
      .select({
        tenantId: sales.tenantId,
        total: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
      })
      .from(sales)
      .where(
        and(inArray(sales.tenantId, tenantIds), gt(sales.saleDate, thirtyDaysAgo)),
      )
      .groupBy(sales.tenantId),

    db
      .select({
        tenantId: sales.tenantId,
        total: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
      })
      .from(sales)
      .where(
        and(
          inArray(sales.tenantId, tenantIds),
          gt(sales.saleDate, sixtyDaysAgo),
          sql`${sales.saleDate} <= ${toIso(thirtyDaysAgo)}::timestamptz`,
        ),
      )
      .groupBy(sales.tenantId),

    db
      .select({
        tenantId: paymentAttempts.tenantId,
        count: sql<number>`count(*)::int`,
      })
      .from(paymentAttempts)
      .where(
        and(
          inArray(paymentAttempts.tenantId, tenantIds),
          eq(paymentAttempts.status, "failed"),
          gt(paymentAttempts.attemptedAt, thirtyDaysAgo),
        ),
      )
      .groupBy(paymentAttempts.tenantId),
  ]);

  // Normalise raw rows: `sql<Date | null>` from aggregates round-trips as a
  // string with some driver versions. Force a Date everywhere so the scoring
  // layer can call `.getTime()` safely and tests stay deterministic.
  const toDateOrNull = (v: unknown): Date | null => {
    if (v == null) return null;
    if (v instanceof Date) return v;
    const d = new Date(v as string);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const subMap = new Map(
    subscriptionRows.map((r) => [
      r.tenantId,
      {
        status: r.status,
        trialEndsAt: toDateOrNull(r.trialEndsAt) ?? new Date(0),
        cancelledAt: toDateOrNull(r.cancelledAt),
      },
    ]),
  );
  const empTotalMap = new Map(employeeTotals.map((r) => [r.tenantId, r.count]));
  const empActiveArr = (
    Array.isArray(employeeActive)
      ? employeeActive
      : (employeeActive as { rows?: { tenant_id: string; count: number }[] }).rows
  ) as Array<{ tenant_id: string; count: number }> | undefined;
  const empActiveMap = new Map((empActiveArr ?? []).map((r) => [r.tenant_id, Number(r.count)]));
  const lastActivityMap = new Map(
    lastActivity.map((r) => [r.tenantId, toDateOrNull(r.lastAt)] as const),
  );
  const lastSaleMap = new Map(
    lastSale.map((r) => [r.tenantId, toDateOrNull(r.lastAt)] as const),
  );
  const sales30Map = new Map(sales30.map((r) => [r.tenantId, Number(r.total)]));
  const salesPrevMap = new Map(salesPrev30.map((r) => [r.tenantId, Number(r.total)]));
  const paymentFailMap = new Map(
    paymentFailures.map((r) => [r.tenantId, r.count]),
  );

  // Health flags are computed per-tenant from an existing helper. In the
  // worst case (50-row list) that's 50 × 3 queries; we parallelise them.
  const flagsEntries = await Promise.all(
    tenantIds.map(async (id) => [id, await computeHealthFlags(id)] as const),
  );
  const flagsMap = new Map(flagsEntries);

  for (const t of tenantRows) {
    const sub = subMap.get(t.id);
    out.set(t.id, {
      tenantId: t.id,
      createdAt: toDateOrNull(t.createdAt) ?? new Date(0),
      suspendedAt: toDateOrNull(t.suspendedAt),
      subscription: sub
        ? {
            status: sub.status,
            trialEndsAt: sub.trialEndsAt,
            cancelledAt: sub.cancelledAt,
          }
        : null,
      employeeTotal: empTotalMap.get(t.id) ?? 0,
      employeeActiveLast30d: empActiveMap.get(t.id) ?? 0,
      lastActivityAt: lastActivityMap.get(t.id) ?? null,
      lastSaleAt: lastSaleMap.get(t.id) ?? null,
      salesLast30d: sales30Map.get(t.id) ?? 0,
      salesPrev30d: salesPrevMap.get(t.id) ?? 0,
      paymentFailuresLast30d: paymentFailMap.get(t.id) ?? 0,
      flags: flagsMap.get(t.id) ?? [],
    });
  }
  return out;
}

// ── Pure scoring (unit-testable) ────────────────────────────────────────────

/**
 * Health weights — total 100.
 *
 *   activity        20   recency of ANY user action (last login proxy via
 *                        activity_logs).
 *   sales           20   last 30d > 0 AND not declining more than 50%.
 *   employees       15   ratio of active employees over the last 30d.
 *   recent_activity 15   any activity at all in the last 7d.
 *   subscription    15   active or trialing-with-days-left are full; past_due,
 *                        suspended, cancelled, expired dock points.
 *   flags           15   existing health-flags.ts — 5 pts per green flag.
 *
 * Why these weights: activity + sales dominate because an unused POS is a
 * failing POS; subscription state is a hard-floor trigger but not the main
 * story of "how well the store is doing" (we already surface it separately).
 * Doc: tweak the WEIGHTS constant to rebalance — the categories are
 * independent so changing one doesn't bleed into another.
 */
export const HEALTH_WEIGHTS = {
  activity: 20,
  sales: 20,
  employees: 15,
  recent_activity: 15,
  subscription: 15,
  flags: 15,
} as const;

export function scoreHealth(
  s: TenantSignals,
  now: Date = new Date(),
): StoreHealth {
  const categories: HealthCategory[] = [];
  const reasons: Reason[] = [];

  // ── activity (last login proxy = last activity) ───────────────────────────
  const w = HEALTH_WEIGHTS;
  let activityScore: number;
  if (!s.lastActivityAt) {
    activityScore = 0;
    reasons.push({ key: "admin.health.reasons.noActivityEver" });
  } else {
    const days = daysBetween(now, s.lastActivityAt);
    if (days <= 1) activityScore = w.activity;
    else if (days <= 3) activityScore = Math.round(w.activity * 0.85);
    else if (days <= 7) activityScore = Math.round(w.activity * 0.65);
    else if (days <= 14) {
      activityScore = Math.round(w.activity * 0.4);
      reasons.push({ key: "admin.health.reasons.lowActivity", params: { days } });
    } else {
      activityScore = 0;
      reasons.push({ key: "admin.health.reasons.inactiveDays", params: { days } });
    }
  }
  categories.push({ key: "activity", score: activityScore, max: w.activity });

  // ── sales (last 30d volume + trend vs prior 30d) ──────────────────────────
  let salesScore: number;
  if (s.salesLast30d === 0 && s.salesPrev30d === 0) {
    salesScore = 0;
    reasons.push({ key: "admin.health.reasons.noSales60d" });
  } else if (s.salesLast30d === 0) {
    salesScore = Math.round(w.sales * 0.1);
    reasons.push({ key: "admin.health.reasons.noSales30d" });
  } else if (s.salesPrev30d === 0) {
    // Fresh momentum — treat as healthy.
    salesScore = w.sales;
  } else {
    const changePct = (s.salesLast30d - s.salesPrev30d) / s.salesPrev30d;
    if (changePct >= 0) {
      salesScore = w.sales;
    } else if (changePct > -0.25) {
      salesScore = Math.round(w.sales * 0.85);
    } else if (changePct > -0.5) {
      salesScore = Math.round(w.sales * 0.6);
      reasons.push({
        key: "admin.health.reasons.salesDeclinedModerate",
        params: { pct: Math.round(Math.abs(changePct) * 100) },
      });
    } else {
      salesScore = Math.round(w.sales * 0.25);
      reasons.push({
        key: "admin.health.reasons.salesDeclinedSevere",
        params: { pct: Math.round(Math.abs(changePct) * 100) },
      });
    }
  }
  categories.push({ key: "sales", score: salesScore, max: w.sales });

  // ── employees (active / total ratio) ──────────────────────────────────────
  let employeesScore: number;
  if (s.employeeTotal === 0) {
    employeesScore = 0;
    reasons.push({ key: "admin.health.reasons.noEmployees" });
  } else {
    const ratio = s.employeeActiveLast30d / s.employeeTotal;
    if (ratio >= 0.8) employeesScore = w.employees;
    else if (ratio >= 0.5) employeesScore = Math.round(w.employees * 0.75);
    else if (ratio >= 0.25) {
      employeesScore = Math.round(w.employees * 0.5);
      reasons.push({
        key: "admin.health.reasons.lowEmployeeActivity",
        params: { active: s.employeeActiveLast30d, total: s.employeeTotal },
      });
    } else {
      employeesScore = Math.round(w.employees * 0.15);
      reasons.push({
        key: "admin.health.reasons.veryLowEmployeeActivity",
        params: { active: s.employeeActiveLast30d, total: s.employeeTotal },
      });
    }
  }
  categories.push({ key: "employees", score: employeesScore, max: w.employees });

  // ── recent activity (any write in last 7d) ────────────────────────────────
  let recentScore: number;
  if (!s.lastActivityAt) {
    recentScore = 0;
  } else if (daysBetween(now, s.lastActivityAt) <= 7) {
    recentScore = w.recent_activity;
  } else {
    recentScore = 0;
  }
  categories.push({ key: "recent_activity", score: recentScore, max: w.recent_activity });

  // ── subscription ──────────────────────────────────────────────────────────
  let subScore: number;
  if (s.suspendedAt) {
    subScore = 0;
    reasons.push({ key: "admin.health.reasons.suspended" });
  } else if (!s.subscription) {
    subScore = Math.round(w.subscription * 0.5);
  } else {
    switch (s.subscription.status) {
      case "active":
        subScore = w.subscription;
        break;
      case "trialing": {
        const daysLeft = daysBetween(s.subscription.trialEndsAt, now);
        if (daysLeft > 7) subScore = w.subscription;
        else if (daysLeft > 0) {
          subScore = Math.round(w.subscription * 0.8);
          reasons.push({
            key: "admin.health.reasons.trialExpiresSoon",
            params: { days: daysLeft },
          });
        } else {
          subScore = Math.round(w.subscription * 0.3);
          reasons.push({ key: "admin.health.reasons.trialExpired" });
        }
        break;
      }
      case "past_due":
        subScore = Math.round(w.subscription * 0.3);
        reasons.push({ key: "admin.health.reasons.paymentPastDue" });
        break;
      case "cancelled":
      case "expired":
        subScore = 0;
        reasons.push({ key: `admin.health.reasons.subscription_${s.subscription.status}` });
        break;
      default:
        subScore = Math.round(w.subscription * 0.5);
    }
  }
  categories.push({ key: "subscription", score: subScore, max: w.subscription });

  // ── existing health-flags rollup ──────────────────────────────────────────
  let flagsScore: number;
  if (s.flags.length === 0) {
    flagsScore = w.flags;
  } else {
    const okCount = s.flags.filter((f) => f.severity === "ok").length;
    flagsScore = Math.round((okCount / s.flags.length) * w.flags);
    const warn = s.flags.filter((f) => f.severity === "warn");
    for (const f of warn) {
      reasons.push({ key: `admin.health.reasons.flag_${f.key}`, params: { value: f.value } });
    }
  }
  categories.push({ key: "flags", score: flagsScore, max: w.flags });

  const score = categories.reduce((n, c) => n + c.score, 0);
  const status: HealthStatus =
    score >= 80 ? "healthy" : score >= 50 ? "attention" : "at_risk";
  return { score, status, categories, reasons };
}

/**
 * Risk-rule weights — SHARED between the per-store TS scorer (`scoreRisk`)
 * and the platform-wide SQL aggregator (`countTenantsByRiskLevel`). Changing
 * a weight in one path without the other would make the Overview "high risk"
 * count disagree with the per-store badge. The cross-check test in
 * `tests/unit/store-health-sql-parity.test.ts` runs both paths over the
 * same signal set and asserts identical levels.
 */
export const RISK_WEIGHTS = {
  suspended: 5,
  paymentFailed: 2,
  trialExpiringSoon: 1,
  trialExpiredOrExpiredStatus: 2,
  subscriptionCancelled: 2,
  noSalesEver: 1,
  noSales14dPlus: 2,
  noSales7to13d: 1,
  salesDeclined50pct: 1,
  employeesInactive: 1,
  ownerInactive8dPlus: 1,
} as const;

export const RISK_THRESHOLDS = {
  low: 1,
  medium: 3,
  high: 5,
} as const;

export function levelForRiskScore(score: number): RiskLevel {
  if (score >= RISK_THRESHOLDS.high) return "high";
  if (score >= RISK_THRESHOLDS.medium) return "medium";
  if (score >= RISK_THRESHOLDS.low) return "low";
  return "healthy";
}

/**
 * Deterministic risk rules. Every matched rule contributes a weight and a
 * reason. The sum of weights maps to a level via {@link levelForRiskScore}.
 *
 * The level calibration lives alongside the rules so a reviewer can weigh
 * them side-by-side.
 */
export function scoreRisk(
  s: TenantSignals,
  now: Date = new Date(),
): StoreRisk {
  const reasons: Reason[] = [];
  let score = 0;
  const W = RISK_WEIGHTS;

  // Suspension is a definitive high-risk signal regardless of other data.
  // Weight {suspended} (not 3) so a suspended tenant is "high" even when the
  // rest of the signals still look clean — an ops/billing/compliance crisis
  // outweighs organic store health by definition.
  if (s.suspendedAt) {
    score += W.suspended;
    reasons.push({ key: "admin.risk.reasons.suspended" });
  }

  // Payment failure is a hard customer-success signal.
  if (s.paymentFailuresLast30d > 0) {
    score += W.paymentFailed;
    reasons.push({
      key: "admin.risk.reasons.paymentFailed",
      params: { count: s.paymentFailuresLast30d },
    });
  }

  if (s.subscription) {
    const daysLeft = daysBetween(s.subscription.trialEndsAt, now);
    if (s.subscription.status === "trialing" && daysLeft >= 0 && daysLeft <= 3) {
      score += W.trialExpiringSoon;
      reasons.push({
        key: "admin.risk.reasons.trialExpiringSoon",
        params: { days: daysLeft },
      });
    }
    if (
      (s.subscription.status === "trialing" && daysLeft < 0) ||
      s.subscription.status === "expired"
    ) {
      score += W.trialExpiredOrExpiredStatus;
      reasons.push({ key: "admin.risk.reasons.trialExpired" });
    }
    if (s.subscription.status === "cancelled") {
      score += W.subscriptionCancelled;
      reasons.push({ key: "admin.risk.reasons.subscriptionCancelled" });
    }
  }

  // Sales inactivity.
  if (!s.lastSaleAt) {
    score += W.noSalesEver;
    reasons.push({ key: "admin.risk.reasons.noSalesEver" });
  } else {
    const d = daysBetween(now, s.lastSaleAt);
    if (d >= 14) {
      score += W.noSales14dPlus;
      reasons.push({ key: "admin.risk.reasons.noSalesDays", params: { days: d } });
    } else if (d >= 7) {
      score += W.noSales7to13d;
      reasons.push({ key: "admin.risk.reasons.noSalesDays", params: { days: d } });
    }
  }

  // Severe sales decline (prev window non-zero so the ratio is meaningful).
  if (s.salesPrev30d > 0) {
    const changePct = (s.salesLast30d - s.salesPrev30d) / s.salesPrev30d;
    if (changePct <= -0.5) {
      score += W.salesDeclined50pct;
      reasons.push({
        key: "admin.risk.reasons.salesDeclined",
        params: { pct: Math.round(Math.abs(changePct) * 100) },
      });
    }
  }

  // Employee inactivity — only meaningful once there are a few employees.
  if (s.employeeTotal >= 3 && s.employeeActiveLast30d <= 1) {
    score += W.employeesInactive;
    reasons.push({
      key: "admin.risk.reasons.employeesInactive",
      params: { active: s.employeeActiveLast30d, total: s.employeeTotal },
    });
  }

  // Owner activity — proxy: last activity_logs any-author row.
  if (s.lastActivityAt) {
    const d = daysBetween(now, s.lastActivityAt);
    if (d >= 8) {
      score += W.ownerInactive8dPlus;
      reasons.push({ key: "admin.risk.reasons.ownerInactive", params: { days: d } });
    }
  }

  return { level: levelForRiskScore(score), score, reasons };
}

// ── Top-level batch APIs ────────────────────────────────────────────────────

/** Compute health + risk for N tenants. Reuses one signal-gather pass. */
export async function computeHealthAndRiskBatch(
  tenantIds: string[],
): Promise<Map<string, { health: StoreHealth; risk: StoreRisk }>> {
  const signals = await gatherStoreSignals(tenantIds);
  const now = new Date();
  const out = new Map<string, { health: StoreHealth; risk: StoreRisk }>();
  for (const [id, s] of signals) {
    out.set(id, { health: scoreHealth(s, now), risk: scoreRisk(s, now) });
  }
  return out;
}

/** Single-tenant convenience — for the detail page. Same formulas. */
export async function computeStoreHealthDetail(
  tenantId: string,
): Promise<{ health: StoreHealth; risk: StoreRisk; signals: TenantSignals } | null> {
  const map = await gatherStoreSignals([tenantId]);
  const s = map.get(tenantId);
  if (!s) return null;
  const now = new Date();
  return { health: scoreHealth(s, now), risk: scoreRisk(s, now), signals: s };
}

// ── Platform-wide risk rollup (exact, one SQL) ──────────────────────────────

export interface RiskLevelCounts {
  healthy: number;
  low: number;
  medium: number;
  high: number;
}

/**
 * Exact per-level tenant count across the ENTIRE platform. One query, CTE-
 * based, scales linearly in the tenant universe (not quadratically) and
 * never samples.
 *
 * The rule weights are embedded directly from {@link RISK_WEIGHTS} so a
 * weight change in the TS scorer propagates automatically; the thresholds
 * are embedded from {@link RISK_THRESHOLDS}. Parity with the per-store TS
 * scorer is enforced by `tests/unit/store-health-sql-parity.test.ts`.
 *
 * Signals (per tenant, all tenant_id scoped, no branch columns):
 *   is_suspended             tenants.suspended_at IS NOT NULL
 *   sub_status / trial       subscriptions.status, .trial_ends_at
 *   payment_failures_30d     count(payment_attempts where status=failed)
 *   last_sale_at             max(sales.sale_date)
 *   last_activity_at         max(activity_logs.created_at)
 *   sales_last_30 / prev_30  sum(sales.total_price::numeric) over 30d / 30..60d
 *   employee_total           count(distinct tenant_members.user_id)
 *   employee_active_30d      count(distinct tm.user_id) with ANY activity_logs row
 *                            under that (tenant_id,user_id) in last 30d
 */
export async function countTenantsByRiskLevel(
  now: Date = new Date(),
): Promise<RiskLevelCounts> {
  const db = getAdminDb();
  const W = RISK_WEIGHTS;
  const T = RISK_THRESHOLDS;
  const nowIso = toIso(now);

  type Row = {
    healthy: number | string;
    low: number | string;
    medium: number | string;
    high: number | string;
  };

  const rows = (await db.execute(sql`
    WITH tenant_signals AS (
      SELECT
        t.id,
        (t.suspended_at IS NOT NULL) AS is_suspended,
        s.status AS sub_status,
        s.trial_ends_at,
        COALESCE((
          SELECT COUNT(*)::int
          FROM payment_attempts pa
          WHERE pa.tenant_id = t.id
            AND pa.status = 'failed'
            AND pa.attempted_at > (${nowIso}::timestamptz - INTERVAL '30 days')
        ), 0) AS payment_failures_30d,
        (SELECT MAX(sale_date) FROM sales WHERE tenant_id = t.id) AS last_sale_at,
        (SELECT MAX(created_at) FROM activity_logs WHERE tenant_id = t.id) AS last_activity_at,
        COALESCE((
          SELECT SUM(total_price::numeric)
          FROM sales
          WHERE tenant_id = t.id
            AND sale_date > (${nowIso}::timestamptz - INTERVAL '30 days')
        ), 0) AS sales_last_30,
        COALESCE((
          SELECT SUM(total_price::numeric)
          FROM sales
          WHERE tenant_id = t.id
            AND sale_date > (${nowIso}::timestamptz - INTERVAL '60 days')
            AND sale_date <= (${nowIso}::timestamptz - INTERVAL '30 days')
        ), 0) AS sales_prev_30,
        COALESCE((
          SELECT COUNT(DISTINCT tm.user_id)::int
          FROM tenant_members tm
          WHERE tm.tenant_id = t.id
        ), 0) AS employee_total,
        COALESCE((
          SELECT COUNT(DISTINCT tm.user_id)::int
          FROM tenant_members tm
          WHERE tm.tenant_id = t.id
            AND EXISTS (
              SELECT 1 FROM activity_logs al
              WHERE al.actor_user_id = tm.user_id
                AND al.tenant_id = tm.tenant_id
                AND al.created_at > (${nowIso}::timestamptz - INTERVAL '30 days')
            )
        ), 0) AS employee_active_30d
      FROM tenants t
      LEFT JOIN subscriptions s ON s.tenant_id = t.id
    ),
    scored AS (
      SELECT
        id,
        (
          CASE WHEN is_suspended THEN ${W.suspended} ELSE 0 END +
          CASE WHEN payment_failures_30d > 0 THEN ${W.paymentFailed} ELSE 0 END +
          CASE
            WHEN sub_status = 'trialing'
                 AND trial_ends_at >= ${nowIso}::timestamptz
                 AND trial_ends_at < (${nowIso}::timestamptz + INTERVAL '4 days')
            THEN ${W.trialExpiringSoon}
            ELSE 0
          END +
          CASE
            WHEN (sub_status = 'trialing' AND trial_ends_at < ${nowIso}::timestamptz)
                 OR sub_status = 'expired'
            THEN ${W.trialExpiredOrExpiredStatus}
            ELSE 0
          END +
          CASE WHEN sub_status = 'cancelled' THEN ${W.subscriptionCancelled} ELSE 0 END +
          CASE WHEN last_sale_at IS NULL THEN ${W.noSalesEver} ELSE 0 END +
          CASE
            WHEN last_sale_at IS NOT NULL
                 AND last_sale_at <= (${nowIso}::timestamptz - INTERVAL '14 days')
            THEN ${W.noSales14dPlus}
            WHEN last_sale_at IS NOT NULL
                 AND last_sale_at <= (${nowIso}::timestamptz - INTERVAL '7 days')
                 AND last_sale_at > (${nowIso}::timestamptz - INTERVAL '14 days')
            THEN ${W.noSales7to13d}
            ELSE 0
          END +
          CASE
            WHEN sales_prev_30 > 0
                 AND ((sales_last_30 - sales_prev_30) / sales_prev_30) <= -0.5
            THEN ${W.salesDeclined50pct}
            ELSE 0
          END +
          CASE
            WHEN employee_total >= 3 AND employee_active_30d <= 1
            THEN ${W.employeesInactive}
            ELSE 0
          END +
          CASE
            WHEN last_activity_at IS NOT NULL
                 AND last_activity_at <= (${nowIso}::timestamptz - INTERVAL '8 days')
            THEN ${W.ownerInactive8dPlus}
            ELSE 0
          END
        ) AS risk_score
      FROM tenant_signals
    )
    SELECT
      COUNT(*) FILTER (WHERE risk_score = 0)::int AS healthy,
      COUNT(*) FILTER (WHERE risk_score >= ${T.low} AND risk_score < ${T.medium})::int AS low,
      COUNT(*) FILTER (WHERE risk_score >= ${T.medium} AND risk_score < ${T.high})::int AS medium,
      COUNT(*) FILTER (WHERE risk_score >= ${T.high})::int AS high
    FROM scored
  `)) as unknown as Row[];

  // Drizzle's sql.execute returns either an array or { rows: [...] } depending
  // on the driver flavour. Normalise.
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as unknown) as { rows: Row[] }).rows;
  const r = arr?.[0];
  return {
    healthy: Number(r?.healthy ?? 0),
    low: Number(r?.low ?? 0),
    medium: Number(r?.medium ?? 0),
    high: Number(r?.high ?? 0),
  };
}

// ── Attention digest for the overview "Requires Attention" section ──────────

export interface AttentionDigest {
  critical: {
    suspended: number;
    paymentFailures30d: number;
  };
  atRisk: {
    highRiskStores: number;
  };
  attention: {
    trialsExpiring7d: number;
    mediumRiskStores: number;
  };
}

/**
 * Overview digest — every count is EXACT across the full tenant population.
 *
 *   suspended / payment failures / trials expiring → direct aggregate queries
 *   high-risk / medium-risk                        → {@link countTenantsByRiskLevel}
 *                                                    (one SQL CTE, no sampling)
 *
 * Nothing here samples. The high/medium counts are the authoritative totals
 * the admin can act on; clicking through takes them to the same-filtered
 * tenant list, which computes the per-store scores for display.
 */
export async function getAttentionDigest(): Promise<AttentionDigest> {
  const db = getAdminDb();
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * MS_PER_DAY);
  const sevenDaysFromNow = new Date(now.getTime() + 7 * MS_PER_DAY);

  const [suspendedRow, paymentFailuresRow, trialsExpiringRow, riskCounts] =
    await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(tenants)
        .where(isNotNull(tenants.suspendedAt)),
      db
        .select({
          count: sql<number>`count(distinct ${paymentAttempts.tenantId})::int`,
        })
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.status, "failed"),
            gt(paymentAttempts.attemptedAt, thirtyDaysAgo),
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.status, "trialing"),
            gt(subscriptions.trialEndsAt, now),
            sql`${subscriptions.trialEndsAt} <= ${toIso(sevenDaysFromNow)}::timestamptz`,
          ),
        ),
      countTenantsByRiskLevel(now),
    ]);

  return {
    critical: {
      suspended: suspendedRow[0]?.count ?? 0,
      paymentFailures30d: paymentFailuresRow[0]?.count ?? 0,
    },
    atRisk: { highRiskStores: riskCounts.high },
    attention: {
      trialsExpiring7d: trialsExpiringRow[0]?.count ?? 0,
      mediumRiskStores: riskCounts.medium,
    },
  };
}
