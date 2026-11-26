/**
 * Phase 1 — Store Health + Risk scoring unit tests.
 *
 * Pure-function tests over synthetic TenantSignals. Covers the weight
 * bands, status thresholds, and every rule in the risk engine. No DB.
 */
import { describe, expect, it } from "vitest";
import {
  scoreHealth,
  scoreRisk,
  HEALTH_WEIGHTS,
  type TenantSignals,
} from "@/lib/admin/store-health";
import type { HealthFlag } from "@/lib/admin/health-flags";

const NOW = new Date("2026-11-17T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

/** A perfectly healthy store. Every category scores max. */
function healthySignals(): TenantSignals {
  return {
    tenantId: "t-healthy",
    createdAt: daysAgo(120),
    suspendedAt: null,
    subscription: {
      status: "active",
      trialEndsAt: daysAgo(90),
      cancelledAt: null,
    },
    employeeTotal: 4,
    employeeActiveLast30d: 4,
    lastActivityAt: daysAgo(0),
    lastSaleAt: daysAgo(0),
    salesLast30d: 50_000,
    salesPrev30d: 45_000, // growing
    paymentFailuresLast30d: 0,
    flags: okFlags(),
  };
}

function okFlags(): HealthFlag[] {
  return [
    { key: "digest_not_configured", severity: "ok", value: 0 },
    { key: "no_sales_7d", severity: "ok", value: 0 },
    { key: "dormant_employees_30d", severity: "ok", value: 0 },
  ];
}

describe("scoreHealth — happy path", () => {
  it("awards the full 100 to a perfectly healthy store", () => {
    const r = scoreHealth(healthySignals(), NOW);
    expect(r.score).toBe(100);
    expect(r.status).toBe("healthy");
    expect(r.reasons).toEqual([]);
    // Every category at max.
    for (const c of r.categories) {
      expect(c.score).toBe(c.max);
    }
  });

  it("recognises fresh-momentum sales (prev 0, current >0) as full points", () => {
    const s = healthySignals();
    s.salesPrev30d = 0;
    s.salesLast30d = 10_000;
    expect(scoreHealth(s, NOW).categories.find((c) => c.key === "sales")?.score).toBe(
      HEALTH_WEIGHTS.sales,
    );
  });
});

describe("scoreHealth — activity bands", () => {
  it("drops activity gradually as the last-activity age grows", () => {
    const bands: Array<[number, number]> = [
      [0, HEALTH_WEIGHTS.activity],
      [2, Math.round(HEALTH_WEIGHTS.activity * 0.85)],
      [5, Math.round(HEALTH_WEIGHTS.activity * 0.65)],
      [10, Math.round(HEALTH_WEIGHTS.activity * 0.4)],
      [30, 0],
    ];
    for (const [age, expected] of bands) {
      const s = healthySignals();
      s.lastActivityAt = daysAgo(age);
      const r = scoreHealth(s, NOW);
      expect(r.categories.find((c) => c.key === "activity")?.score).toBe(expected);
    }
  });

  it("flags 'noActivityEver' when no activity row exists", () => {
    const s = healthySignals();
    s.lastActivityAt = null;
    const r = scoreHealth(s, NOW);
    expect(r.reasons.some((x) => x.key === "admin.health.reasons.noActivityEver")).toBe(true);
  });
});

describe("scoreHealth — sales trend", () => {
  it("flags severe decline when sales dropped > 50% vs prior window", () => {
    const s = healthySignals();
    s.salesPrev30d = 100_000;
    s.salesLast30d = 30_000; // -70%
    const r = scoreHealth(s, NOW);
    const salesCat = r.categories.find((c) => c.key === "sales")!;
    expect(salesCat.score).toBeLessThan(HEALTH_WEIGHTS.sales * 0.5);
    expect(
      r.reasons.find((x) => x.key === "admin.health.reasons.salesDeclinedSevere"),
    ).toBeDefined();
  });

  it("flags moderate decline between 25% and 50%", () => {
    const s = healthySignals();
    s.salesPrev30d = 100_000;
    s.salesLast30d = 60_000; // -40%
    const r = scoreHealth(s, NOW);
    expect(
      r.reasons.find((x) => x.key === "admin.health.reasons.salesDeclinedModerate"),
    ).toBeDefined();
  });

  it("gives full sales points when growing", () => {
    const s = healthySignals();
    s.salesPrev30d = 100_000;
    s.salesLast30d = 120_000;
    const r = scoreHealth(s, NOW);
    expect(r.categories.find((c) => c.key === "sales")?.score).toBe(HEALTH_WEIGHTS.sales);
  });

  it("zeroes sales and flags noSales60d when both windows are zero", () => {
    const s = healthySignals();
    s.salesPrev30d = 0;
    s.salesLast30d = 0;
    const r = scoreHealth(s, NOW);
    expect(r.categories.find((c) => c.key === "sales")?.score).toBe(0);
    expect(r.reasons.find((x) => x.key === "admin.health.reasons.noSales60d")).toBeDefined();
  });
});

describe("scoreHealth — status thresholds", () => {
  it("maps 100 to 'healthy', 60 to 'attention', 20 to 'at_risk'", () => {
    const makeScore = (target: number): TenantSignals => {
      // Craft a signal set that roughly lands at the desired total.
      // Start from healthy, drop categories one by one.
      const s = healthySignals();
      if (target <= 80) s.lastActivityAt = daysAgo(30); // wipes activity + recent
      if (target <= 60) {
        s.salesPrev30d = 100_000;
        s.salesLast30d = 10_000; // severe decline
      }
      if (target <= 40) s.employeeActiveLast30d = 0;
      if (target <= 20) s.suspendedAt = daysAgo(1);
      return s;
    };
    expect(scoreHealth(makeScore(100), NOW).status).toBe("healthy");
    expect(scoreHealth(makeScore(70), NOW).status).toBe("attention");
    expect(scoreHealth(makeScore(30), NOW).status).toBe("at_risk");
  });
});

describe("scoreHealth — subscription category", () => {
  it("full points for 'active'", () => {
    const r = scoreHealth(healthySignals(), NOW);
    expect(r.categories.find((c) => c.key === "subscription")?.score).toBe(
      HEALTH_WEIGHTS.subscription,
    );
  });

  it("flags trial expiring in <= 7 days with a reason", () => {
    const s = healthySignals();
    s.subscription = {
      status: "trialing",
      trialEndsAt: daysFromNow(2),
      cancelledAt: null,
    };
    const r = scoreHealth(s, NOW);
    expect(
      r.reasons.find((x) => x.key === "admin.health.reasons.trialExpiresSoon"),
    ).toBeDefined();
  });

  it("zeroes subscription category when suspended", () => {
    const s = healthySignals();
    s.suspendedAt = daysAgo(1);
    const r = scoreHealth(s, NOW);
    expect(r.categories.find((c) => c.key === "subscription")?.score).toBe(0);
    expect(r.reasons.find((x) => x.key === "admin.health.reasons.suspended")).toBeDefined();
  });

  it("drops subscription badly when past_due", () => {
    const s = healthySignals();
    s.subscription = {
      status: "past_due",
      trialEndsAt: daysAgo(90),
      cancelledAt: null,
    };
    const r = scoreHealth(s, NOW);
    expect(r.categories.find((c) => c.key === "subscription")?.score).toBeLessThan(
      HEALTH_WEIGHTS.subscription * 0.5,
    );
  });
});

describe("scoreHealth — employees category", () => {
  it("gives full points when 80%+ active", () => {
    const s = healthySignals();
    s.employeeTotal = 10;
    s.employeeActiveLast30d = 9;
    const r = scoreHealth(s, NOW);
    expect(r.categories.find((c) => c.key === "employees")?.score).toBe(HEALTH_WEIGHTS.employees);
  });

  it("reasons 'veryLowEmployeeActivity' when <25% active", () => {
    const s = healthySignals();
    s.employeeTotal = 10;
    s.employeeActiveLast30d = 2;
    const r = scoreHealth(s, NOW);
    expect(
      r.reasons.find((x) => x.key === "admin.health.reasons.veryLowEmployeeActivity"),
    ).toBeDefined();
  });
});

describe("scoreHealth — existing flags rollup", () => {
  it("gives full points when every flag is ok", () => {
    const r = scoreHealth(healthySignals(), NOW);
    expect(r.categories.find((c) => c.key === "flags")?.score).toBe(HEALTH_WEIGHTS.flags);
  });

  it("drops proportionally when half the flags warn", () => {
    const s = healthySignals();
    s.flags = [
      { key: "digest_not_configured", severity: "warn", value: 1 },
      { key: "no_sales_7d", severity: "ok", value: 0 },
      { key: "dormant_employees_30d", severity: "warn", value: 2 },
    ];
    const r = scoreHealth(s, NOW);
    const cat = r.categories.find((c) => c.key === "flags")!;
    // 1 ok of 3 → round(1/3 * 15) = 5
    expect(cat.score).toBe(5);
    // Two warn-flag reasons added.
    expect(r.reasons.filter((x) => x.key.startsWith("admin.health.reasons.flag_"))).toHaveLength(2);
  });
});

describe("scoreRisk — rule engine", () => {
  it("returns 'healthy' + no reasons for a thriving store", () => {
    const r = scoreRisk(healthySignals(), NOW);
    expect(r.level).toBe("healthy");
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it("marks suspended tenants as high risk regardless of other signals", () => {
    const s = healthySignals();
    s.suspendedAt = daysAgo(1);
    const r = scoreRisk(s, NOW);
    expect(r.level).toBe("high");
    expect(r.reasons.map((x) => x.key)).toContain("admin.risk.reasons.suspended");
  });

  it("stacks multiple weak signals into 'medium' or 'high'", () => {
    const s = healthySignals();
    s.lastSaleAt = daysAgo(10); // +1
    s.paymentFailuresLast30d = 1; // +2
    s.lastActivityAt = daysAgo(9); // owner inactive +1
    s.salesPrev30d = 100_000;
    s.salesLast30d = 10_000; // -90% +1
    const r = scoreRisk(s, NOW);
    expect(["medium", "high"]).toContain(r.level);
    expect(r.reasons.length).toBeGreaterThanOrEqual(4);
  });

  it("flags trial-expiring vs trial-expired with distinct reasons", () => {
    const expiring = healthySignals();
    expiring.subscription = {
      status: "trialing",
      trialEndsAt: daysFromNow(2),
      cancelledAt: null,
    };
    const expired = healthySignals();
    expired.subscription = {
      status: "trialing",
      trialEndsAt: daysAgo(5),
      cancelledAt: null,
    };
    expect(scoreRisk(expiring, NOW).reasons.map((x) => x.key)).toContain(
      "admin.risk.reasons.trialExpiringSoon",
    );
    expect(scoreRisk(expired, NOW).reasons.map((x) => x.key)).toContain(
      "admin.risk.reasons.trialExpired",
    );
  });

  it("does not add false-positive reasons when the store is healthy", () => {
    const s = healthySignals();
    const r = scoreRisk(s, NOW);
    // No "no sales ever" — we DO have a sale.
    expect(r.reasons.map((x) => x.key)).not.toContain("admin.risk.reasons.noSalesEver");
    // No employee-inactive flag — all 4 are active.
    expect(r.reasons.map((x) => x.key)).not.toContain("admin.risk.reasons.employeesInactive");
  });

  it("thresholds the level correctly at 0 / 1-2 / 3-4 / 5+", () => {
    const base = healthySignals();
    // 0 → healthy
    expect(scoreRisk(base, NOW).level).toBe("healthy");

    // +1 for no-sale-8-days → low
    const lowS = healthySignals();
    lowS.lastSaleAt = daysAgo(8);
    expect(scoreRisk(lowS, NOW).level).toBe("low");

    // +3 for suspended → medium (actually medium at 3)
    const medS = healthySignals();
    medS.suspendedAt = daysAgo(1);
    const medR = scoreRisk(medS, NOW);
    expect(["medium", "high"]).toContain(medR.level);

    // +5 — stack many → high
    const highS = healthySignals();
    highS.suspendedAt = daysAgo(1); // +3
    highS.paymentFailuresLast30d = 1; // +2
    const highR = scoreRisk(highS, NOW);
    expect(highR.level).toBe("high");
  });
});
