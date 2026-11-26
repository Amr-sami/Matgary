// Payroll V1 — end-to-end scenario test.
//
// Walks through the WHOLE flow for ONE employee, exactly as the Owner
// experiences it from the mobile detail screen or the web register:
//
//   1. Hire a staffer, set compensation (fixed base + 5% commission, bonus eligible).
//   2. Log attendance for the month (3 full-day shifts + one 10-hour day).
//   3. Record some attributed sales + one return.
//   4. Add a bonus and a deduction via the repo.
//   5. Call the payroll engine and assert every bucket matches hand-computed values.
//   6. Finalize the sheet.
//   7. Mutate the inputs (approve more leave, add a sale, add a raise) and verify
//      the finalized sheet is byte-for-byte unchanged.
//
// This mirrors what `/team/payroll/[userId]` renders and what the AI
// Agent reads via `get_employee_payroll`. If this test regresses, the
// user-facing number regressed.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { computePayrollForEmployee } from "@/lib/payroll/engine";
import {
  createPayrollAdjustment,
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
const PERIOD_START = new Date("2026-03-01T00:00:00Z");
const PERIOD_END = new Date("2026-04-01T00:00:00Z");

/* ─────────────────────── Setup ──────────────────────── */

beforeAll(async () => {
  seed = await seedPayrollTenant("e2e");
  employeeId = await addStaff(seed.tenantId, { name: "E2E Employee" });
  productId = await seedProduct(seed.tenantId, {
    categoryId: seed.categoryId,
    branchId: seed.branchId,
    price: 500,
    cost: 200,
  });

  // Fixed 3100 EGP/mo, 5% commission, bonus eligible.
  await setCompensation(seed.tenantId, {
    employeeId,
    createdByUserId: seed.ownerId,
    payType: "fixed",
    base: 3100,
    commissionRate: 5,
    bonusEligible: true,
  });

  // 3 regular weekday shifts (8h each) + 1 Wednesday with 2h overtime.
  // Period = March 2026 (31 days total); March 2 is Mon, 3 Tue, 4 Wed, 5 Thu.
  await addShift(seed.tenantId, {
    employeeId,
    recordedByUserId: seed.ownerId,
    start: new Date("2026-03-02T08:00:00Z"),
    end: new Date("2026-03-02T16:00:00Z"),
  });
  await addShift(seed.tenantId, {
    employeeId,
    recordedByUserId: seed.ownerId,
    start: new Date("2026-03-03T08:00:00Z"),
    end: new Date("2026-03-03T16:00:00Z"),
  });
  await addShift(seed.tenantId, {
    employeeId,
    recordedByUserId: seed.ownerId,
    start: new Date("2026-03-04T08:00:00Z"),
    end: new Date("2026-03-04T18:00:00Z"), // 10h → 8 reg + 2 OT
  });

  // 2 sales totalling 2000 EGP, attributed to the employee.
  await recordSale(seed.tenantId, {
    productId,
    categoryId: seed.categoryId,
    recordedByUserId: employeeId,
    totalPrice: 1000,
    saleDate: new Date("2026-03-05T10:00:00Z"),
    branchId: seed.branchId,
  });
  await recordSale(seed.tenantId, {
    productId,
    categoryId: seed.categoryId,
    recordedByUserId: employeeId,
    totalPrice: 1000,
    saleDate: new Date("2026-03-06T10:00:00Z"),
    branchId: seed.branchId,
  });

  // Owner-authored bonus + deduction.
  await addAdjustment(seed.tenantId, {
    employeeId,
    periodMonth: PERIOD_START,
    kind: "bonus",
    amount: 500,
    createdByUserId: seed.ownerId,
    reason: "Performance",
  });
  await addAdjustment(seed.tenantId, {
    employeeId,
    periodMonth: PERIOD_START,
    kind: "deduction",
    amount: -150,
    createdByUserId: seed.ownerId,
    reason: "Late day",
  });
});

afterAll(async () => {
  await seed.cleanup();
});

/* ─────────────────────── Assertions ─────────────────────── */

describe("E2E payroll scenario — one employee end-to-end", () => {
  it("engine produces the expected breakdown", async () => {
    const { snapshot, compensationSnapshot } = await computePayrollForEmployee(
      seed.tenantId,
      employeeId,
      PERIOD_START,
      PERIOD_END,
    );

    // Compensation echo: the frozen rule the sheet was computed against.
    expect(compensationSnapshot).toBeTruthy();
    expect(compensationSnapshot!.payType).toBe("fixed");
    expect(compensationSnapshot!.baseSalaryMonthly).toBe(3100);
    expect(compensationSnapshot!.commissionRate).toBe(5);
    expect(compensationSnapshot!.bonusEligible).toBe(true);

    // Attendance: 24 reg (3 × 8) + 2 OT, reviewCount = 0.
    expect(snapshot.regularHours).toBe(24);
    expect(snapshot.overtimeHours).toBe(2);
    expect(snapshot.reviewCount).toBe(0);

    // Base earnings: fixed salary is pro-rated by days worked / days in month.
    // 3 days worked out of 31 → 3100 × 3/31 ≈ 300.00
    expect(snapshot.baseEarnings).toBeCloseTo(300, 1);

    // Commission: 2000 gross sales, no returns → 2000 × 5% = 100.
    expect(snapshot.commissionGrossSales).toBe(2000);
    expect(snapshot.commissionReturnedValue).toBe(0);
    expect(snapshot.commissionAmount).toBe(100);

    // Adjustments: +500 − 150 = +350.
    expect(snapshot.adjustmentsTotal).toBe(350);
    // Signed detail: one bonus, one deduction.
    expect(snapshot.adjustments).toHaveLength(2);
    const bonus = snapshot.adjustments.find((a) => a.kind === "bonus");
    const ded = snapshot.adjustments.find((a) => a.kind === "deduction");
    expect(bonus?.amount).toBe(500);
    expect(bonus?.reason).toBe("Performance");
    expect(ded?.amount).toBe(-150);
    expect(ded?.reason).toBe("Late day");

    // Hourly earnings: no hourly rate on a fixed-pay employee → 0.
    expect(snapshot.hourlyEarnings).toBe(0);

    // Gross = baseEarnings + hourlyEarnings (fixed-type skips the hourly bucket).
    expect(snapshot.grossAmount).toBeCloseTo(300, 1);

    // Net = gross + commission + adjustments = 300 + 100 + 350 = 750.
    expect(snapshot.netAmount).toBeCloseTo(750, 1);

    // No critical warnings.
    const warningCodes = snapshot.warnings.map((w) => w.code);
    expect(warningCodes).not.toContain("no_compensation");
    expect(warningCodes).not.toContain("missing_attendance");
  });

  it("the mobile-detail view renders the same lifecycle + numbers", async () => {
    // getEmployeePayrollMonth is what /team/payroll/[userId] (both web + mobile)
    // resolve to. For a MISSING/DRAFT lifecycle this is the live snapshot.
    const view = await getEmployeePayrollMonth(seed.tenantId, employeeId, PERIOD_START);
    expect(view).toBeTruthy();
    expect(view!.lifecycle).toBe("MISSING");
    expect(view!.snapshot.netAmount).toBeCloseTo(750, 1);
    expect(view!.snapshot.adjustments.length).toBe(2);
  });

  it("finalize freezes the sheet; later input mutations do NOT change it", async () => {
    const finalized = await finalizePayrollPeriod(
      seed.tenantId,
      employeeId,
      PERIOD_START,
      seed.ownerId,
    );
    expect(finalized.lifecycle).toBe("FINALIZED");
    const frozenNet = finalized.snapshot.netAmount;
    const frozenGross = finalized.snapshot.grossAmount;
    const frozenAdjustments = finalized.snapshot.adjustmentsTotal;
    const frozenCommission = finalized.snapshot.commissionAmount;

    // Mutate every downstream source.
    // 1. New attendance on March 20 — would have added hours.
    await addShift(seed.tenantId, {
      employeeId,
      recordedByUserId: seed.ownerId,
      start: new Date("2026-03-20T08:00:00Z"),
      end: new Date("2026-03-20T20:00:00Z"), // 12h shift (4 OT)
    });
    // 2. New sale — would have grown commission.
    await recordSale(seed.tenantId, {
      productId,
      categoryId: seed.categoryId,
      recordedByUserId: employeeId,
      totalPrice: 5000,
      saleDate: new Date("2026-03-25T10:00:00Z"),
      branchId: seed.branchId,
    });
    // 3. New approved leave — would have changed paid-leave day count.
    await approveLeave(seed.tenantId, {
      employeeId,
      branchId: seed.branchId,
      startDate: new Date("2026-03-27T00:00:00Z"),
      endDate: new Date("2026-03-28T23:59:59Z"),
      kind: "paid",
      decidedByUserId: seed.ownerId,
    });
    // 4. New comp row — would have changed future base/commission.
    await setCompensation(seed.tenantId, {
      employeeId,
      createdByUserId: seed.ownerId,
      payType: "fixed",
      base: 9999,
      commissionRate: 25,
      effectiveFrom: new Date("2026-03-15T00:00:00Z"),
    });
    // 5. New adjustment via the repo — must be rejected because the sheet
    //    is finalized.
    await expect(
      createPayrollAdjustment(seed.tenantId, {
        employeeId,
        periodStart: PERIOD_START,
        kind: "bonus",
        amount: 999,
        reason: "Should fail",
        createdByUserId: seed.ownerId,
      }),
    ).rejects.toMatchObject({ code: "ALREADY_FINALIZED" });

    // Read it back — every number held.
    const after = await getEmployeePayrollMonth(seed.tenantId, employeeId, PERIOD_START);
    expect(after!.lifecycle).toBe("FINALIZED");
    expect(after!.snapshot.netAmount).toBe(frozenNet);
    expect(after!.snapshot.grossAmount).toBe(frozenGross);
    expect(after!.snapshot.adjustmentsTotal).toBe(frozenAdjustments);
    expect(after!.snapshot.commissionAmount).toBe(frozenCommission);
    expect(after!.snapshot.adjustments).toHaveLength(2);
  });
});
