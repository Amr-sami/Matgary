/**
 * Doc 15 spec 13 §7 T4 — the payments report gains `wallet` and the
 * collections split (13 §4.11, acceptance 8), against the real DB.
 * Fixture: tests/unit/helpers/collections-report-fixture.ts (real cart path).
 * Skipped unless DATABASE_URL names a `test` database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPaymentMixReport } from "@/lib/repo/insights-deep";
import { seedReportFixture, type ReportFixture } from "./helpers/collections-report-fixture";

const hasTestDb = /test/i.test(process.env.DATABASE_URL ?? "");
const saved = process.env.COLLECTIONS_ENABLED;
let fx: ReportFixture;
const window = () => ({ from: new Date(Date.now() - 36 * 3_600_000), to: new Date(Date.now() + 60_000) });

beforeAll(async () => {
  if (!hasTestDb) return;
  process.env.COLLECTIONS_ENABLED = "on";
  fx = await seedReportFixture("t4");
});

afterAll(() => {
  if (saved === undefined) delete process.env.COLLECTIONS_ENABLED;
  else process.env.COLLECTIONS_ENABLED = saved;
});

describe.skipIf(!hasTestDb)("payments report split (13 §4.11)", () => {
  it("lists wallet as a method; the gross series is revenue by the line's method", async () => {
    const r = await loadPaymentMixReport(fx.tenantId, window(), fx.branchId);
    expect(r.methods).toEqual(["cash", "instapay", "wallet", "deferred"]);
    // The 60 debt line moved to deferred on rejection (Q4).
    expect(r.totals).toEqual({ cash: 100, instapay: 420, wallet: 200, deferred: 60 });
  });

  it("split values exactly: confirmed / pending / rejected debt / rejected loss per method, cash remainder, unverified", async () => {
    const r = await loadPaymentMixReport(fx.tenantId, window(), fx.branchId);
    expect(r.collections).toEqual({
      byMethod: {
        instapay: { confirmed: 300, autoConfirmed: 0, pending: 0, rejectedDebt: 60, rejectedLoss: 80 },
        wallet: { confirmed: 0, autoConfirmed: 0, pending: 150, rejectedDebt: 0, rejectedLoss: 0 },
      },
      cashRemainder: 50,
      unverified: 40,
    });
  });

  it("reconciles (acceptance 8): Σ parts + cash remainder = Σ totals of the digital invoices", async () => {
    const r = await loadPaymentMixReport(fx.tenantId, window(), fx.branchId);
    const c = r.collections!;
    const parts = (["instapay", "wallet"] as const).reduce(
      (s, m) => s + c.byMethod[m].confirmed + c.byMethod[m].autoConfirmed + c.byMethod[m].pending + c.byMethod[m].rejectedDebt + c.byMethod[m].rejectedLoss,
      0,
    );
    // Digital invoices: 300 + 200 + 80 + 60 (the unverified 40 has no collection).
    expect(parts + c.cashRemainder).toBe(640);
  });

  it("all-branches scope (null) and all-time window (null) give the same split for a one-branch tenant", async () => {
    const scoped = await loadPaymentMixReport(fx.tenantId, window(), fx.branchId);
    const all = await loadPaymentMixReport(fx.tenantId, null, null);
    expect(all.collections).toEqual(scoped.collections);
  });

  it("an empty window → zeros, not null", async () => {
    const past = { from: new Date("2020-01-01T00:00:00Z"), to: new Date("2020-01-02T00:00:00Z") };
    const r = await loadPaymentMixReport(fx.tenantId, past, fx.branchId);
    expect(r.collections).toEqual({
      byMethod: {
        instapay: { confirmed: 0, autoConfirmed: 0, pending: 0, rejectedDebt: 0, rejectedLoss: 0 },
        wallet: { confirmed: 0, autoConfirmed: 0, pending: 0, rejectedDebt: 0, rejectedLoss: 0 },
      },
      cashRemainder: 0,
      unverified: 0,
    });
  });

  it("flag off → collections: null and the series identical", async () => {
    const on = await loadPaymentMixReport(fx.tenantId, window(), fx.branchId);
    process.env.COLLECTIONS_ENABLED = "off";
    const off = await loadPaymentMixReport(fx.tenantId, window(), fx.branchId);
    process.env.COLLECTIONS_ENABLED = "on";
    expect(off.collections).toBeNull();
    expect(off.series).toEqual(on.series);
    expect(off.totals).toEqual(on.totals);
    expect(off.methods).toEqual(on.methods);
  });
});
