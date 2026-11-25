/**
 * SQL ↔ TS risk-scoring parity.
 *
 * `countTenantsByRiskLevel` lives in SQL (one CTE) and `scoreRisk` lives in
 * TypeScript. They MUST produce identical risk scores for the same input or
 * the Overview "high-risk" count will disagree with the per-store badges.
 *
 * Strategy
 * ────────
 * The SQL path is a mechanical translation of the TS rules, using the SAME
 * `RISK_WEIGHTS` and `RISK_THRESHOLDS` constants. We don't spin up Postgres
 * here — we mirror the SQL's rule logic in a small pure-TS clone
 * (`computeRiskScoreMirror`) and assert it returns the same per-score and
 * per-level values as `scoreRisk` across a large synthetic signal matrix.
 *
 * If a future change breaks parity (e.g. someone adds a rule to `scoreRisk`
 * but forgets the SQL CTE), this test fails until the mirror clone is also
 * updated — forcing the author to look at the SQL side.
 *
 * A separate live-DB smoke-test runs in the stabilization shell script.
 */
import { describe, expect, it } from "vitest";
import {
  levelForRiskScore,
  RISK_THRESHOLDS,
  RISK_WEIGHTS,
  scoreRisk,
  type TenantSignals,
} from "@/lib/admin/store-health";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-17T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * MS_PER_DAY);
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * MS_PER_DAY);

/**
 * PURE-TS clone of the SQL CTE in countTenantsByRiskLevel. Updated
 * side-by-side with the SQL. Any divergence is a test failure.
 */
function computeRiskScoreMirror(s: TenantSignals, now: Date = NOW): number {
  const W = RISK_WEIGHTS;
  let score = 0;

  // is_suspended
  if (s.suspendedAt) score += W.suspended;

  // payment_failures_30d > 0
  if (s.paymentFailuresLast30d > 0) score += W.paymentFailed;

  // Subscription rules
  if (s.subscription) {
    // trial expiring soon: trial_ends >= now AND trial_ends < now+4d
    if (
      s.subscription.status === "trialing" &&
      s.subscription.trialEndsAt.getTime() >= now.getTime() &&
      s.subscription.trialEndsAt.getTime() < now.getTime() + 4 * MS_PER_DAY
    ) {
      score += W.trialExpiringSoon;
    }
    // trial expired / status expired
    if (
      (s.subscription.status === "trialing" &&
        s.subscription.trialEndsAt.getTime() < now.getTime()) ||
      s.subscription.status === "expired"
    ) {
      score += W.trialExpiredOrExpiredStatus;
    }
    if (s.subscription.status === "cancelled") {
      score += W.subscriptionCancelled;
    }
  }

  // Sales inactivity
  if (s.lastSaleAt == null) {
    score += W.noSalesEver;
  } else if (
    s.lastSaleAt.getTime() <= now.getTime() - 14 * MS_PER_DAY
  ) {
    score += W.noSales14dPlus;
  } else if (
    s.lastSaleAt.getTime() <= now.getTime() - 7 * MS_PER_DAY
  ) {
    score += W.noSales7to13d;
  }

  // Severe decline — divide-by-zero guard
  if (s.salesPrev30d > 0) {
    const changePct = (s.salesLast30d - s.salesPrev30d) / s.salesPrev30d;
    if (changePct <= -0.5) score += W.salesDeclined50pct;
  }

  // Employees inactive
  if (s.employeeTotal >= 3 && s.employeeActiveLast30d <= 1) {
    score += W.employeesInactive;
  }

  // Owner inactive 8d+
  if (
    s.lastActivityAt != null &&
    s.lastActivityAt.getTime() <= now.getTime() - 8 * MS_PER_DAY
  ) {
    score += W.ownerInactive8dPlus;
  }

  return score;
}

/** Minimal "all signals neutral" signal set. Individual tests override one
 *  field at a time to exercise one rule in isolation. */
function base(): TenantSignals {
  return {
    tenantId: "test",
    createdAt: daysAgo(100),
    suspendedAt: null,
    subscription: {
      status: "active",
      trialEndsAt: daysAgo(90),
      cancelledAt: null,
    },
    employeeTotal: 1,
    employeeActiveLast30d: 1,
    lastActivityAt: daysAgo(0),
    lastSaleAt: daysAgo(0),
    salesLast30d: 10_000,
    salesPrev30d: 9_000,
    paymentFailuresLast30d: 0,
    flags: [],
  };
}

// Exhaustive matrix — one entry per rule, plus boundary cases.
const CASES: Array<{ name: string; signal: TenantSignals }> = [
  { name: "baseline healthy", signal: base() },
  {
    name: "suspended",
    signal: Object.assign(base(), { suspendedAt: daysAgo(1) }),
  },
  {
    name: "payment failed",
    signal: Object.assign(base(), { paymentFailuresLast30d: 1 }),
  },
  {
    name: "trial expires in 0 days",
    signal: Object.assign(base(), {
      subscription: {
        status: "trialing" as const,
        trialEndsAt: daysFromNow(0),
        cancelledAt: null,
      },
    }),
  },
  {
    name: "trial expires in 3 days (boundary)",
    signal: Object.assign(base(), {
      subscription: {
        status: "trialing" as const,
        trialEndsAt: daysFromNow(3),
        cancelledAt: null,
      },
    }),
  },
  {
    name: "trial expires in 4 days (should NOT fire)",
    signal: Object.assign(base(), {
      subscription: {
        status: "trialing" as const,
        trialEndsAt: daysFromNow(4),
        cancelledAt: null,
      },
    }),
  },
  {
    name: "trial expired yesterday",
    signal: Object.assign(base(), {
      subscription: {
        status: "trialing" as const,
        trialEndsAt: daysAgo(1),
        cancelledAt: null,
      },
    }),
  },
  {
    name: "subscription cancelled",
    signal: Object.assign(base(), {
      subscription: {
        status: "cancelled" as const,
        trialEndsAt: daysAgo(90),
        cancelledAt: daysAgo(5),
      },
    }),
  },
  {
    name: "no sales ever",
    signal: Object.assign(base(), { lastSaleAt: null }),
  },
  {
    name: "last sale exactly 7 days ago (boundary — low band)",
    signal: Object.assign(base(), { lastSaleAt: daysAgo(7) }),
  },
  {
    name: "last sale 13 days ago (still low band)",
    signal: Object.assign(base(), { lastSaleAt: daysAgo(13) }),
  },
  {
    name: "last sale exactly 14 days ago (boundary — high band)",
    signal: Object.assign(base(), { lastSaleAt: daysAgo(14) }),
  },
  {
    name: "sales declined 50% exactly",
    signal: Object.assign(base(), { salesPrev30d: 100_000, salesLast30d: 50_000 }),
  },
  {
    name: "sales declined 49% (should NOT fire)",
    signal: Object.assign(base(), { salesPrev30d: 100_000, salesLast30d: 51_000 }),
  },
  {
    name: "employees mostly inactive (3/1)",
    signal: Object.assign(base(), { employeeTotal: 3, employeeActiveLast30d: 1 }),
  },
  {
    name: "owner inactive 8d (boundary)",
    signal: Object.assign(base(), { lastActivityAt: daysAgo(8) }),
  },
  {
    name: "owner inactive 7d (should NOT fire)",
    signal: Object.assign(base(), { lastActivityAt: daysAgo(7) }),
  },
  {
    name: "combo: suspended + payment failed + cancelled",
    signal: Object.assign(base(), {
      suspendedAt: daysAgo(1),
      paymentFailuresLast30d: 1,
      subscription: {
        status: "cancelled" as const,
        trialEndsAt: daysAgo(90),
        cancelledAt: daysAgo(5),
      },
    }),
  },
];

describe("SQL ↔ TS risk-score parity", () => {
  it("each rule's score matches between scoreRisk() and the SQL mirror", () => {
    for (const c of CASES) {
      const tsScore = scoreRisk(c.signal, NOW).score;
      const sqlMirror = computeRiskScoreMirror(c.signal, NOW);
      expect({ case: c.name, score: sqlMirror }).toEqual({
        case: c.name,
        score: tsScore,
      });
    }
  });

  it("each rule's level matches via levelForRiskScore", () => {
    for (const c of CASES) {
      const tsLevel = scoreRisk(c.signal, NOW).level;
      const sqlLevel = levelForRiskScore(computeRiskScoreMirror(c.signal, NOW));
      expect({ case: c.name, level: sqlLevel }).toEqual({
        case: c.name,
        level: tsLevel,
      });
    }
  });

  it("thresholds sort correctly", () => {
    expect(RISK_THRESHOLDS.low).toBe(1);
    expect(RISK_THRESHOLDS.medium).toBe(3);
    expect(RISK_THRESHOLDS.high).toBe(5);
    expect(levelForRiskScore(0)).toBe("healthy");
    expect(levelForRiskScore(1)).toBe("low");
    expect(levelForRiskScore(2)).toBe("low");
    expect(levelForRiskScore(3)).toBe("medium");
    expect(levelForRiskScore(4)).toBe("medium");
    expect(levelForRiskScore(5)).toBe("high");
    expect(levelForRiskScore(99)).toBe("high");
  });
});
