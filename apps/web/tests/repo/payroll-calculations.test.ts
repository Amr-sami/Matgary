// Payroll V1 — calculation correctness against real Postgres.
//
// The pure engine tests in tests/unit/payroll-engine.test.ts prove the
// composition math from hand-built inputs. This suite proves that the
// full async wrapper loading attendance, sales, returns, leave, and
// adjustments FROM THE DATABASE arrives at the same answers.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import { sales } from "@/lib/db/schema";
import { computePayrollForEmployee } from "@/lib/payroll/engine";
import {
  addAdjustment,
  addShift,
  addStaff,
  approveLeave,
  recordReturn,
  recordSale,
  seedPayrollTenant,
  seedProduct,
  setCompensation,
  type PayrollTenantSeed,
} from "./payroll-fixtures";

let seed: PayrollTenantSeed;
let productId: string;
const MONTH_START = new Date("2026-03-01T00:00:00Z");
const MONTH_END = new Date("2026-04-01T00:00:00Z");

beforeAll(async () => {
  seed = await seedPayrollTenant("calc");
  productId = await seedProduct(seed.tenantId, {
    categoryId: seed.categoryId,
    branchId: seed.branchId,
    price: 100,
    cost: 50,
  });
});

afterAll(async () => {
  await seed.cleanup();
});

/** Each test gets a fresh employee to keep assertions independent. */
async function freshEmployee(name: string): Promise<string> {
  return addStaff(seed.tenantId, { name });
}

describe("payroll calculations — compensation types", () => {
  it("fixed salary: full month → pays full base, no hourly earnings", async () => {
    const emp = await freshEmployee("Fixed Ali");
    await setCompensation(seed.tenantId, {
      employeeId: emp,
      createdByUserId: seed.ownerId,
      payType: "fixed",
      base: 3100,
    });
    // One workday in March
    await addShift(seed.tenantId, {
      employeeId: emp,
      recordedByUserId: seed.ownerId,
      start: new Date("2026-03-02T08:00:00Z"),
      end: new Date("2026-03-02T16:00:00Z"),
    });
    const { snapshot } = await computePayrollForEmployee(
      seed.tenantId,
      emp,
      MONTH_START,
      MONTH_END,
    );
    expect(snapshot.payType).toBe("fixed");
    // 1 day of 31 days in March at 3100 EGP/mo ≈ 100.00
    expect(snapshot.baseEarnings).toBeCloseTo(100, 1);
    expect(snapshot.hourlyEarnings).toBe(0);
    expect(snapshot.grossAmount).toBeCloseTo(100, 1);
  });

  it("hourly: pays regular + overtime hours with overtime multiplier", async () => {
    const emp = await freshEmployee("Hourly Omar");
    await setCompensation(seed.tenantId, {
      employeeId: emp,
      createdByUserId: seed.ownerId,
      payType: "hourly",
      hourly: 50,
    });
    // 10h day (non-weekend Mon Mar 2) → 8 regular + 2 OT @ 1.5x
    await addShift(seed.tenantId, {
      employeeId: emp,
      recordedByUserId: seed.ownerId,
      start: new Date("2026-03-02T08:00:00Z"),
      end: new Date("2026-03-02T18:00:00Z"),
    });
    const { snapshot } = await computePayrollForEmployee(
      seed.tenantId,
      emp,
      MONTH_START,
      MONTH_END,
    );
    expect(snapshot.regularHours).toBe(8);
    expect(snapshot.overtimeHours).toBe(2);
    // 8 × 50 + 2 × 50 × 1.5 = 400 + 150 = 550
    expect(snapshot.hourlyEarnings).toBe(550);
    expect(snapshot.baseEarnings).toBe(0);
    expect(snapshot.grossAmount).toBe(550);
  });

  it("hybrid: base covers regular weekday hours, overtime + weekend bill hourly", async () => {
    const emp = await freshEmployee("Hybrid Hana");
    await setCompensation(seed.tenantId, {
      employeeId: emp,
      createdByUserId: seed.ownerId,
      payType: "hybrid",
      base: 3100,
      hourly: 50,
    });
    // Mon Mar 2: 10h → 8 regular (covered by base) + 2 OT hourly
    await addShift(seed.tenantId, {
      employeeId: emp,
      recordedByUserId: seed.ownerId,
      start: new Date("2026-03-02T08:00:00Z"),
      end: new Date("2026-03-02T18:00:00Z"),
    });
    const { snapshot } = await computePayrollForEmployee(
      seed.tenantId,
      emp,
      MONTH_START,
      MONTH_END,
    );
    // baseEarnings = 3100 × 1/31 ≈ 100; OT hourly = 2 × 50 × 1.5 = 150
    expect(snapshot.baseEarnings).toBeCloseTo(100, 1);
    expect(snapshot.hourlyEarnings).toBe(150);
    expect(snapshot.grossAmount).toBeCloseTo(250, 1);
  });

  it("absence: no shifts → 0 base, 0 hourly, missing_attendance warning", async () => {
    const emp = await freshEmployee("Absent Nada");
    await setCompensation(seed.tenantId, {
      employeeId: emp,
      createdByUserId: seed.ownerId,
      payType: "fixed",
      base: 3100,
    });
    const { snapshot } = await computePayrollForEmployee(
      seed.tenantId,
      emp,
      MONTH_START,
      MONTH_END,
    );
    expect(snapshot.grossAmount).toBe(0);
    expect(snapshot.warnings.map((w) => w.code)).toContain("missing_attendance");
  });
});

describe("payroll calculations — leave", () => {
  it("paid leave: counts days without inflating base (base is attendance-driven here)", async () => {
    const emp = await freshEmployee("Paid Leave Pat");
    await setCompensation(seed.tenantId, {
      employeeId: emp,
      createdByUserId: seed.ownerId,
      payType: "fixed",
      base: 3100,
    });
    await approveLeave(seed.tenantId, {
      employeeId: emp,
      branchId: seed.branchId,
      startDate: new Date("2026-03-10T00:00:00Z"),
      endDate: new Date("2026-03-12T23:59:59Z"),
      kind: "paid",
      decidedByUserId: seed.ownerId,
    });
    const { snapshot } = await computePayrollForEmployee(
      seed.tenantId,
      emp,
      MONTH_START,
      MONTH_END,
    );
    expect(snapshot.paidLeaveDays).toBe(3);
    expect(snapshot.unpaidLeaveDays).toBe(0);
  });

  it("unpaid leave: counts days separately from paid", async () => {
    const emp = await freshEmployee("Unpaid Leave Uma");
    await setCompensation(seed.tenantId, {
      employeeId: emp,
      createdByUserId: seed.ownerId,
      payType: "fixed",
      base: 3100,
    });
    await approveLeave(seed.tenantId, {
      employeeId: emp,
      branchId: seed.branchId,
      startDate: new Date("2026-03-15T00:00:00Z"),
      endDate: new Date("2026-03-16T23:59:59Z"),
      kind: "unpaid",
      decidedByUserId: seed.ownerId,
    });
    const { snapshot } = await computePayrollForEmployee(
      seed.tenantId,
      emp,
      MONTH_START,
      MONTH_END,
    );
    expect(snapshot.unpaidLeaveDays).toBe(2);
    expect(snapshot.paidLeaveDays).toBe(0);
  });
});

describe("payroll calculations — commission", () => {
  it("commission on net sales (gross - returns) × rate / 100", async () => {
    const emp = await freshEmployee("Commission Cathy");
    await setCompensation(seed.tenantId, {
      employeeId: emp,
      createdByUserId: seed.ownerId,
      payType: "fixed",
      base: 3100,
      commissionRate: 5,
    });
    // 3 sales @ 1000 EGP each, 1 return of 1 unit
    const saleOne = await recordSale(seed.tenantId, {
      productId,
      categoryId: seed.categoryId,
      recordedByUserId: emp,
      totalPrice: 1000,
      saleDate: new Date("2026-03-05T10:00:00Z"),
      branchId: seed.branchId,
    });
    await recordSale(seed.tenantId, {
      productId,
      categoryId: seed.categoryId,
      recordedByUserId: emp,
      totalPrice: 1000,
      saleDate: new Date("2026-03-10T10:00:00Z"),
      branchId: seed.branchId,
    });
    await recordSale(seed.tenantId, {
      productId,
      categoryId: seed.categoryId,
      recordedByUserId: emp,
      totalPrice: 1000,
      saleDate: new Date("2026-03-15T10:00:00Z"),
      branchId: seed.branchId,
    });
    await recordReturn(seed.tenantId, {
      saleId: saleOne,
      productId,
      returnedQuantity: 1,
      returnDate: new Date("2026-03-20T10:00:00Z"),
    });
    const { snapshot } = await computePayrollForEmployee(
      seed.tenantId,
      emp,
      MONTH_START,
      MONTH_END,
    );
    expect(snapshot.commissionGrossSales).toBe(3000);
    expect(snapshot.commissionReturnedValue).toBe(1000);
    expect(snapshot.commissionNetSales).toBe(2000);
    expect(snapshot.commissionAmount).toBe(100); // 2000 × 5%
  });

  it("voided sales are excluded by setting totalPrice via payment lifecycle — but V1 attributes by recordedByUserId and keeps every sale row; a voided POS sale in Storo is deleted not voided in-place, so we instead PROVE: deleting the sale row drops it from attribution", async () => {
    const emp = await freshEmployee("Voidable Vera");
    await setCompensation(seed.tenantId, {
      employeeId: emp,
      createdByUserId: seed.ownerId,
      payType: "fixed",
      base: 3100,
      commissionRate: 10,
    });
    const saleOne = await recordSale(seed.tenantId, {
      productId,
      categoryId: seed.categoryId,
      recordedByUserId: emp,
      totalPrice: 500,
      saleDate: new Date("2026-03-05T10:00:00Z"),
      branchId: seed.branchId,
    });
    const before = await computePayrollForEmployee(
      seed.tenantId,
      emp,
      MONTH_START,
      MONTH_END,
    );
    expect(before.snapshot.commissionGrossSales).toBe(500);

    // Mimic a sale-void: delete the sale row (Storo's sale-void path removes
    // the row, see repo/sales.ts). The engine must drop it from attribution.
    await withTenant(seed.tenantId, async (tx) => {
      await tx.delete(sales).where(and(eq(sales.tenantId, seed.tenantId), eq(sales.id, saleOne)));
    });
    const after = await computePayrollForEmployee(
      seed.tenantId,
      emp,
      MONTH_START,
      MONTH_END,
    );
    expect(after.snapshot.commissionGrossSales).toBe(0);
    expect(after.snapshot.commissionAmount).toBe(0);
  });

  it("legacy sales with NULL recordedByUserId don't attribute to anyone (no false commission)", async () => {
    const emp = await freshEmployee("Legacy Laila");
    await setCompensation(seed.tenantId, {
      employeeId: emp,
      createdByUserId: seed.ownerId,
      payType: "fixed",
      base: 3100,
      commissionRate: 5,
    });
    // Insert a legacy sale with null recordedByUserId.
    await withTenant(seed.tenantId, async (tx) => {
      await tx.insert(sales).values({
        tenantId: seed.tenantId,
        branchId: seed.branchId,
        productId,
        productName: "Widget",
        categoryId: seed.categoryId,
        quantitySold: 1,
        pricePerUnit: "200",
        subtotal: "200",
        totalPrice: "200",
        saleDate: new Date("2026-03-07T10:00:00Z"),
        recordedByUserId: null,
        paymentMethod: "cash",
        isPaid: true,
        amountPaid: "200",
      });
    });
    const { snapshot } = await computePayrollForEmployee(
      seed.tenantId,
      emp,
      MONTH_START,
      MONTH_END,
    );
    expect(snapshot.commissionGrossSales).toBe(0);
  });
});

describe("payroll calculations — adjustments", () => {
  it("bonus + deduction net into adjustmentsTotal and into netAmount", async () => {
    const emp = await freshEmployee("Adjusted Adam");
    await setCompensation(seed.tenantId, {
      employeeId: emp,
      createdByUserId: seed.ownerId,
      payType: "hourly",
      hourly: 50,
    });
    await addShift(seed.tenantId, {
      employeeId: emp,
      recordedByUserId: seed.ownerId,
      start: new Date("2026-03-02T08:00:00Z"),
      end: new Date("2026-03-02T16:00:00Z"),
    });
    await addAdjustment(seed.tenantId, {
      employeeId: emp,
      periodMonth: MONTH_START,
      kind: "bonus",
      amount: 300,
      createdByUserId: seed.ownerId,
    });
    await addAdjustment(seed.tenantId, {
      employeeId: emp,
      periodMonth: MONTH_START,
      kind: "deduction",
      amount: -100,
      createdByUserId: seed.ownerId,
    });
    const { snapshot } = await computePayrollForEmployee(
      seed.tenantId,
      emp,
      MONTH_START,
      MONTH_END,
    );
    // 8h × 50 = 400 gross; + 300 - 100 = 200 adjustments; net = 600
    expect(snapshot.grossAmount).toBe(400);
    expect(snapshot.adjustmentsTotal).toBe(200);
    expect(snapshot.netAmount).toBe(600);
  });
});

describe("payroll calculations — combined scenario", () => {
  it("fixed + overtime + paid leave + commission + bonus deducts correctly", async () => {
    const emp = await freshEmployee("Combined Camila");
    await setCompensation(seed.tenantId, {
      employeeId: emp,
      createdByUserId: seed.ownerId,
      payType: "hybrid",
      base: 3100,
      hourly: 50,
      commissionRate: 2,
    });
    // One 10-hour weekday shift → 8 reg (base) + 2 OT (hourly)
    await addShift(seed.tenantId, {
      employeeId: emp,
      recordedByUserId: seed.ownerId,
      start: new Date("2026-03-04T08:00:00Z"),
      end: new Date("2026-03-04T18:00:00Z"),
    });
    await approveLeave(seed.tenantId, {
      employeeId: emp,
      branchId: seed.branchId,
      startDate: new Date("2026-03-10T00:00:00Z"),
      endDate: new Date("2026-03-11T23:59:59Z"),
      kind: "paid",
      decidedByUserId: seed.ownerId,
    });
    await recordSale(seed.tenantId, {
      productId,
      categoryId: seed.categoryId,
      recordedByUserId: emp,
      totalPrice: 5000,
      saleDate: new Date("2026-03-12T10:00:00Z"),
      branchId: seed.branchId,
    });
    await addAdjustment(seed.tenantId, {
      employeeId: emp,
      periodMonth: MONTH_START,
      kind: "bonus",
      amount: 250,
      createdByUserId: seed.ownerId,
    });
    const { snapshot } = await computePayrollForEmployee(
      seed.tenantId,
      emp,
      MONTH_START,
      MONTH_END,
    );
    expect(snapshot.paidLeaveDays).toBe(2);
    expect(snapshot.baseEarnings).toBeCloseTo(100, 1); // 3100 × 1/31
    expect(snapshot.hourlyEarnings).toBe(150); // 2h × 50 × 1.5
    expect(snapshot.commissionAmount).toBe(100); // 5000 × 2%
    expect(snapshot.adjustmentsTotal).toBe(250);
    expect(snapshot.netAmount).toBeCloseTo(100 + 150 + 100 + 250, 1); // 600
  });
});
