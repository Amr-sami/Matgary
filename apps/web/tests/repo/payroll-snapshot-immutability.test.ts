// Payroll V1 — snapshot immutability.
//
// Once FINALIZED, a payroll row must reproduce the same numbers forever —
// later edits to compensation rows, attendance, leave approvals, sales,
// returns, or payroll adjustments must NOT retroactively change what the
// register, employee detail page, PDF or P&L show for that month.
//
// The engine keeps the live snapshot in `payroll_periods.snapshot` /
// `compensation_snapshot`; the repo view assembler reads FINALIZED rows
// straight from those JSON columns. This test simulates each of the five
// downstream mutations and asserts: before == after.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  attendanceEvents,
  employeeCompensation,
  leaveRequests,
  payrollAdjustments,
  sales,
} from "@/lib/db/schema";
import {
  finalizePayrollPeriod,
  getEmployeePayrollMonth,
} from "@/lib/repo/payroll-periods";
import {
  addAdjustment,
  addShift,
  addStaff,
  approveLeave,
  recordSale,
  seedPayrollTenant,
  seedProduct,
  setCompensation,
  type PayrollTenantSeed,
} from "./payroll-fixtures";

let seed: PayrollTenantSeed;
let employeeId: string;
let productId: string;
const MONTH = new Date("2026-03-01T00:00:00Z");

interface SheetValues {
  gross: number;
  net: number;
  commission: number;
  adjustments: number;
  regularHours: number;
  overtimeHours: number;
  paidLeaveDays: number;
  compensationId: string;
}

function sheetValues(view: Awaited<ReturnType<typeof getEmployeePayrollMonth>>): SheetValues {
  if (!view) throw new Error("expected a sheet view");
  return {
    gross: view.snapshot.grossAmount,
    net: view.snapshot.netAmount,
    commission: view.snapshot.commissionAmount,
    adjustments: view.snapshot.adjustmentsTotal,
    regularHours: view.snapshot.regularHours,
    overtimeHours: view.snapshot.overtimeHours,
    paidLeaveDays: view.snapshot.paidLeaveDays,
    compensationId: view.compensationSnapshot?.id ?? "",
  };
}

beforeAll(async () => {
  seed = await seedPayrollTenant("snap");
  employeeId = await addStaff(seed.tenantId, { name: "Snapshot Sami" });
  productId = await seedProduct(seed.tenantId, {
    categoryId: seed.categoryId,
    branchId: seed.branchId,
    price: 100,
    cost: 50,
  });
  await setCompensation(seed.tenantId, {
    employeeId,
    createdByUserId: seed.ownerId,
    payType: "hybrid",
    base: 3100,
    hourly: 50,
    commissionRate: 5,
    bonusEligible: true,
  });
  // Build a decent sheet: 10h weekday shift + 2 paid leave days + a sale + a bonus.
  await addShift(seed.tenantId, {
    employeeId,
    recordedByUserId: seed.ownerId,
    start: new Date("2026-03-02T08:00:00Z"),
    end: new Date("2026-03-02T18:00:00Z"),
  });
  await approveLeave(seed.tenantId, {
    employeeId,
    branchId: seed.branchId,
    startDate: new Date("2026-03-10T00:00:00Z"),
    endDate: new Date("2026-03-11T23:59:59Z"),
    kind: "paid",
    decidedByUserId: seed.ownerId,
  });
  await recordSale(seed.tenantId, {
    productId,
    categoryId: seed.categoryId,
    recordedByUserId: employeeId,
    totalPrice: 2000,
    saleDate: new Date("2026-03-05T10:00:00Z"),
    branchId: seed.branchId,
  });
  await addAdjustment(seed.tenantId, {
    employeeId,
    periodMonth: MONTH,
    kind: "bonus",
    amount: 200,
    createdByUserId: seed.ownerId,
  });
  // Finalize and capture baseline.
  await finalizePayrollPeriod(seed.tenantId, employeeId, MONTH, seed.ownerId);
});

afterAll(async () => {
  await seed.cleanup();
});

describe("snapshot immutability after FINALIZE", () => {
  let baseline: SheetValues;

  it("captures a non-trivial baseline", async () => {
    const view = await getEmployeePayrollMonth(seed.tenantId, employeeId, MONTH);
    baseline = sheetValues(view);
    expect(baseline.gross).toBeGreaterThan(0);
    expect(baseline.commission).toBeGreaterThan(0);
    expect(baseline.adjustments).toBe(200);
    expect(baseline.paidLeaveDays).toBe(2);
    expect(baseline.compensationId).toBeTruthy();
  });

  it("adding a new compensation row does NOT change the finalized sheet", async () => {
    await setCompensation(seed.tenantId, {
      employeeId,
      createdByUserId: seed.ownerId,
      payType: "hybrid",
      base: 10_000, // massive raise
      hourly: 200,
      commissionRate: 50,
      effectiveFrom: new Date("2026-03-15T00:00:00Z"), // mid-month even
    });
    const view = await getEmployeePayrollMonth(seed.tenantId, employeeId, MONTH);
    expect(sheetValues(view)).toEqual(baseline);
  });

  it("adding more attendance events does NOT change the finalized sheet", async () => {
    await addShift(seed.tenantId, {
      employeeId,
      recordedByUserId: seed.ownerId,
      start: new Date("2026-03-20T08:00:00Z"),
      end: new Date("2026-03-20T20:00:00Z"), // 12h shift that would have added OT
    });
    const view = await getEmployeePayrollMonth(seed.tenantId, employeeId, MONTH);
    expect(sheetValues(view)).toEqual(baseline);
  });

  it("approving new leave does NOT change the finalized sheet", async () => {
    await approveLeave(seed.tenantId, {
      employeeId,
      branchId: seed.branchId,
      startDate: new Date("2026-03-25T00:00:00Z"),
      endDate: new Date("2026-03-28T23:59:59Z"),
      kind: "paid",
      decidedByUserId: seed.ownerId,
    });
    const view = await getEmployeePayrollMonth(seed.tenantId, employeeId, MONTH);
    expect(sheetValues(view)).toEqual(baseline);
  });

  it("adding more attributed sales does NOT change the finalized sheet", async () => {
    await recordSale(seed.tenantId, {
      productId,
      categoryId: seed.categoryId,
      recordedByUserId: employeeId,
      totalPrice: 9999,
      saleDate: new Date("2026-03-15T10:00:00Z"),
      branchId: seed.branchId,
    });
    const view = await getEmployeePayrollMonth(seed.tenantId, employeeId, MONTH);
    expect(sheetValues(view)).toEqual(baseline);
  });

  it("inserting another live adjustment does NOT change the finalized sheet", async () => {
    // The repo refuses to accept this through `createPayrollAdjustment` on a
    // finalized period. To prove even DIRECT inserts don't leak into the
    // frozen snapshot, we bypass the repo and insert raw — the stored
    // snapshot column still rules the view.
    await withTenant(seed.tenantId, async (tx) => {
      await tx.insert(payrollAdjustments).values({
        tenantId: seed.tenantId,
        employeeId,
        periodMonth: MONTH,
        kind: "bonus",
        amount: "500",
        createdByUserId: seed.ownerId,
      });
    });
    const view = await getEmployeePayrollMonth(seed.tenantId, employeeId, MONTH);
    expect(sheetValues(view)).toEqual(baseline);
  });

  it("deleting the underlying compensation row leaves the frozen snapshot intact", async () => {
    // The snapshot's compensationSnapshot is self-contained — the repo view
    // reads from the JSON column, not from the live table.
    const compIdToDelete = baseline.compensationId;
    await withTenant(seed.tenantId, async (tx) => {
      // Only delete the ONE comp row that was in effect at period start.
      await tx
        .delete(employeeCompensation)
        .where(
          and(
            eq(employeeCompensation.tenantId, seed.tenantId),
            eq(employeeCompensation.id, compIdToDelete),
          ),
        );
    });
    const view = await getEmployeePayrollMonth(seed.tenantId, employeeId, MONTH);
    expect(sheetValues(view)).toEqual(baseline);
    // And the compensationSnapshot still echoes the deleted row's id.
    expect(view?.compensationSnapshot?.id).toBe(compIdToDelete);
  });

  // Silence "variable unused" if a future refactor drops the middle tests.
  it("final sanity: baseline is still equal to the live view", async () => {
    // Clean up noise rows we inserted during this suite to keep teardown fast,
    // and assert one more time.
    const view = await getEmployeePayrollMonth(seed.tenantId, employeeId, MONTH);
    expect(sheetValues(view)).toEqual(baseline);
    // Suppress unused-imports lint signal.
    void attendanceEvents;
    void leaveRequests;
    void sales;
  });
});
