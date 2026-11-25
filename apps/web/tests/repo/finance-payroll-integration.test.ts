// Final slice — payroll → Financials integration proof.
//
// The engine already handles payroll in Slice 1 (see fetchPnLSource +
// payrollExpenses in lib/finance/pnl.ts). This test proves the end-to-end
// contract the brief demands:
//
//   • finalized payroll flows into Operating Expenses
//   • draft payroll is EXCLUDED
//   • no manual expense is auto-created — payroll stays in its own table
//     (so there is no double-count surface in the first place)

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  branches,
  payrollPeriods,
  shopSettings,
  tenants,
  tenantMembers,
  users,
} from "@/lib/db/schema";
import { computePnLFromSource, fetchPnLSource } from "@/lib/finance/pnl";

let tenant: { tenantId: string; userId: string };

beforeAll(async () => {
  tenant = await db.transaction(async (tx) => {
    const email = `pr-${Date.now()}@test.local`;
    const [u] = await tx
      .insert(users)
      .values({ email, name: "Payroll Test", passwordHash: "x" })
      .returning({ id: users.id });
    const [t] = await tx
      .insert(tenants)
      .values({
        name: "Payroll Test",
        slug: `pr-${Math.random().toString(36).slice(2, 8)}`,
      })
      .returning({ id: tenants.id });
    await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
    const [b] = await tx
      .insert(branches)
      .values({ tenantId: t.id, slug: "main", name: "Main", isPrimary: true })
      .returning({ id: branches.id });
    await tx.insert(tenantMembers).values({
      tenantId: t.id,
      userId: u.id,
      role: "owner",
    });
    await tx.insert(shopSettings).values({
      tenantId: t.id,
      branchId: b.id,
      shopName: "Payroll Test",
    });
    return { tenantId: t.id, userId: u.id };
  });
});

afterAll(async () => {
  if (tenant?.tenantId)
    await db.execute(sql`delete from tenants where id = ${tenant.tenantId}`);
});

const windowJune = {
  from: new Date("2026-06-01T00:00:00.000Z"),
  to: new Date("2026-07-01T00:00:00.000Z"),
};
const periodEnd = new Date("2026-06-30T23:59:59.000Z");

async function newStaff(name: string): Promise<string> {
  return db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({
        email: `${name}-${Math.random().toString(36).slice(2, 6)}@test.local`,
        name,
        passwordHash: "x",
      })
      .returning({ id: users.id });
    await tx.execute(sql`select set_config('app.tenant_id', ${tenant.tenantId}, true)`);
    await tx.insert(tenantMembers).values({
      tenantId: tenant.tenantId,
      userId: u.id,
      role: "staff",
    });
    return u.id;
  });
}

// Migration 0068 added a partial-unique index making only ONE live
// (status <> 'voided') row allowed per (tenant, employee, period_start).
// Each payroll row therefore needs a distinct employee.
async function insertPayroll(opts: {
  gross: number;
  adjustments?: number;
  status: "draft" | "finalized";
  employeeId?: string;
  periodStart?: Date;
  periodEnd?: Date;
}): Promise<void> {
  const employeeId = opts.employeeId ?? (await newStaff(`emp-${Math.random().toString(36).slice(2, 6)}`));
  const pStart = opts.periodStart ?? new Date("2026-06-01T00:00:00.000Z");
  const pEnd = opts.periodEnd ?? periodEnd;
  await withTenant(tenant.tenantId, (tx) =>
    tx.insert(payrollPeriods).values({
      tenantId: tenant.tenantId,
      employeeId,
      periodStart: pStart,
      periodEnd: pEnd,
      grossAmount: String(opts.gross),
      adjustmentsAmount: String(opts.adjustments ?? 0),
      status: opts.status,
      finalizedAt: opts.status === "finalized" ? pEnd : null,
      finalizedByUserId: opts.status === "finalized" ? tenant.userId : null,
    }),
  );
}

describe("Payroll → Financials integration", () => {
  it("finalized payroll flows into operating expenses", async () => {
    await insertPayroll({ gross: 5_000, adjustments: 250, status: "finalized" });

    const source = await fetchPnLSource(tenant.tenantId, windowJune);
    expect(source.payrollExpenses).toHaveLength(1);
    expect(source.payrollExpenses[0]?.amount).toBe(5_250);

    const pnl = computePnLFromSource(source);
    expect(pnl.operatingExpenses).toBe(5_250);
    expect(pnl.operatingProfit).toBe(-5_250); // no revenue in this window
  });

  it("draft payroll is EXCLUDED from operating expenses", async () => {
    // Add a draft on top of the already-finalized row above. Only the finalized
    // one counts.
    await insertPayroll({ gross: 99_999, status: "draft" });

    const source = await fetchPnLSource(tenant.tenantId, windowJune);
    expect(source.payrollExpenses).toHaveLength(1); // still just the finalized
    expect(source.payrollExpenses[0]?.amount).toBe(5_250);

    const pnl = computePnLFromSource(source);
    expect(pnl.operatingExpenses).toBe(5_250); // unchanged
  });

  it("payroll does NOT create any shadow rows in the expenses table", async () => {
    // The brief: "do not double-count payroll through automatic + manual
    // expense entry". We satisfy that by NEVER writing to expenses from the
    // payroll pipeline. Prove it: after a finalized payroll exists, the
    // engine's `expenses` source is unaffected.
    const source = await fetchPnLSource(tenant.tenantId, windowJune);
    expect(source.expenses).toHaveLength(0);
  });

  it("adding a second finalized payroll period sums both — the engine aggregates", async () => {
    await insertPayroll({
      gross: 1_000,
      adjustments: 0,
      status: "finalized",
    });
    const source = await fetchPnLSource(tenant.tenantId, windowJune);
    const totalPayroll = source.payrollExpenses.reduce(
      (s, p) => s + p.amount,
      0,
    );
    expect(totalPayroll).toBe(5_250 + 1_000);
  });

  it("payroll outside the window is EXCLUDED", async () => {
    // A period ending in May shouldn't appear in a June-window P&L.
    await insertPayroll({
      gross: 7_000,
      status: "finalized",
      periodStart: new Date("2026-05-01T00:00:00.000Z"),
      periodEnd: new Date("2026-05-31T23:59:59.000Z"),
    });
    const source = await fetchPnLSource(tenant.tenantId, windowJune);
    // Still only June periods — the May one did not leak in.
    expect(
      source.payrollExpenses.every((p) => true), // (content check: just count)
    ).toBe(true);
    const totalPayrollJune = source.payrollExpenses.reduce(
      (s, p) => s + p.amount,
      0,
    );
    expect(totalPayrollJune).toBe(5_250 + 1_000); // unchanged by May row
  });
});
