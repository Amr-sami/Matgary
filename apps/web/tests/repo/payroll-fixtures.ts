// Shared fixtures for payroll integration tests. Each test suite calls
// `seedPayrollTenant()` in `beforeAll` to get a fresh tenant with the base
// shape the engine needs (owner, primary branch, shop settings, default
// attendance settings), plus helpers to insert staff, compensation,
// attendance pairs, sales, returns, leave, and adjustments.
//
// The fixtures are tenant-scoped: each test suite gets its OWN tenant so
// the suites can run in parallel (vitest default is isolated forks) without
// cross-contaminating state. `cleanupTenant` is called in `afterAll`.

import { sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  attendanceEvents,
  attendanceSettings,
  branches,
  categories,
  employeeCompensation,
  leaveRequests,
  payrollAdjustments,
  payrollPeriods,
  products,
  returns,
  sales,
  shopSettings,
  tenants,
  tenantMembers,
  users,
} from "@/lib/db/schema";

export interface PayrollTenantSeed {
  tenantId: string;
  branchId: string;
  ownerId: string;
  /** Default category id for seeding products/sales — created with the tenant. */
  categoryId: string;
  cleanup(): Promise<void>;
}

export async function seedPayrollTenant(label: string): Promise<PayrollTenantSeed> {
  const seed = await db.transaction(async (tx) => {
    const slug = `pr-${label}-${Math.random().toString(36).slice(2, 8)}`;
    const [u] = await tx
      .insert(users)
      .values({
        email: `${slug}@test.local`,
        name: `${label} Owner`,
        passwordHash: "x",
      })
      .returning({ id: users.id });
    const [t] = await tx
      .insert(tenants)
      .values({ name: label, slug })
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
      shopName: label,
    });
    await tx.insert(attendanceSettings).values({
      tenantId: t.id,
      workHoursPerDay: "8",
      weekendDays: [5, 6],
      overtimeMultiplier: "1.5",
      graceMinutesLate: 0,
    });
    const [cat] = await tx
      .insert(categories)
      .values({
        tenantId: t.id,
        branchId: b.id,
        key: "default",
        label: "Default",
        position: 0,
      })
      .returning({ id: categories.id });
    return { tenantId: t.id, branchId: b.id, ownerId: u.id, categoryId: cat.id };
  });
  return {
    ...seed,
    cleanup: async () => {
      await db.execute(sql`delete from tenants where id = ${seed.tenantId}`);
    },
  };
}

/* ─────────────────────── Staff / compensation ────────────────────────── */

export async function addStaff(
  tenantId: string,
  args: { name: string; role?: string },
): Promise<string> {
  return db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({
        email: `${args.name.toLowerCase().replace(/\s+/g, "")}-${Math.random()
          .toString(36)
          .slice(2, 6)}@test.local`,
        name: args.name,
        passwordHash: "x",
      })
      .returning({ id: users.id });
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    await tx.insert(tenantMembers).values({
      tenantId,
      userId: u.id,
      role: args.role ?? "staff",
      displayName: args.name,
    });
    return u.id;
  });
}

export async function setCompensation(
  tenantId: string,
  args: {
    employeeId: string;
    createdByUserId: string;
    payType: "fixed" | "hourly" | "hybrid";
    base?: number | null;
    hourly?: number | null;
    standardMonthlyHours?: number | null;
    commissionRate?: number;
    commissionBase?: "gross_sales" | "profit_contribution";
    bonusEligible?: boolean;
    effectiveFrom?: Date;
  },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.insert(employeeCompensation).values({
      tenantId,
      employeeId: args.employeeId,
      payType: args.payType,
      baseSalaryMonthly: args.base == null ? null : String(args.base),
      hourlyRate: args.hourly == null ? null : String(args.hourly),
      standardMonthlyHours:
        args.standardMonthlyHours == null ? null : String(args.standardMonthlyHours),
      commissionRate: String(args.commissionRate ?? 0),
      commissionBase: args.commissionBase ?? "gross_sales",
      bonusEligible: args.bonusEligible ?? false,
      effectiveFrom: args.effectiveFrom ?? new Date("2026-01-01T00:00:00Z"),
      createdByUserId: args.createdByUserId,
    });
  });
}

/* ─────────────────────── Attendance helpers ──────────────────────────── */

export async function addShift(
  tenantId: string,
  args: { employeeId: string; recordedByUserId: string; start: Date; end: Date },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.insert(attendanceEvents).values([
      {
        tenantId,
        employeeId: args.employeeId,
        type: "check_in",
        occurredAt: args.start,
        source: "manual",
        recordedByUserId: args.recordedByUserId,
        requiresReview: false,
      },
      {
        tenantId,
        employeeId: args.employeeId,
        type: "check_out",
        occurredAt: args.end,
        source: "manual",
        recordedByUserId: args.recordedByUserId,
        requiresReview: false,
      },
    ]);
  });
}

/* ─────────────────────────── Sales / returns ─────────────────────────── */

export interface SeedProductArgs {
  categoryId: string;
  branchId: string;
  name?: string;
  price?: number;
  cost?: number;
}
export async function seedProduct(
  tenantId: string,
  args: SeedProductArgs,
): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const [p] = await tx
      .insert(products)
      .values({
        tenantId,
        branchId: args.branchId,
        categoryId: args.categoryId,
        name: args.name ?? "Widget",
        price: String(args.price ?? 100),
        costPrice: String(args.cost ?? 60),
        quantity: 100,
      })
      .returning({ id: products.id });
    return p.id;
  });
}

export async function recordSale(
  tenantId: string,
  args: {
    productId: string;
    categoryId: string;
    recordedByUserId: string | null;
    totalPrice: number;
    quantity?: number;
    saleDate: Date;
    branchId: string;
  },
): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const qty = args.quantity ?? 1;
    const [row] = await tx
      .insert(sales)
      .values({
        tenantId,
        branchId: args.branchId,
        productId: args.productId,
        productName: "Widget",
        categoryId: args.categoryId,
        quantitySold: qty,
        pricePerUnit: String(args.totalPrice / qty),
        subtotal: String(args.totalPrice),
        totalPrice: String(args.totalPrice),
        saleDate: args.saleDate,
        recordedByUserId: args.recordedByUserId,
        paymentMethod: "cash",
        isPaid: true,
        amountPaid: String(args.totalPrice),
      })
      .returning({ id: sales.id });
    return row.id;
  });
}

export async function recordReturn(
  tenantId: string,
  args: {
    saleId: string;
    productId: string;
    returnedQuantity: number;
    returnDate: Date;
  },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.insert(returns).values({
      tenantId,
      saleId: args.saleId,
      productId: args.productId,
      productName: "Widget",
      returnedQuantity: args.returnedQuantity,
      returnDate: args.returnDate,
    });
  });
}

/* ─────────────────────────── Leave / adjustments ─────────────────────── */

export async function approveLeave(
  tenantId: string,
  args: {
    employeeId: string;
    branchId: string;
    startDate: Date;
    endDate: Date;
    kind: "paid" | "unpaid";
    decidedByUserId: string;
  },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.insert(leaveRequests).values({
      tenantId,
      branchId: args.branchId,
      userId: args.employeeId,
      startDate: args.startDate,
      endDate: args.endDate,
      status: "approved",
      kind: args.kind,
      decidedByUserId: args.decidedByUserId,
      decidedAt: new Date(),
    });
  });
}

export async function addAdjustment(
  tenantId: string,
  args: {
    employeeId: string;
    periodMonth: Date;
    kind: "bonus" | "deduction" | "advance_repayment" | "correction";
    amount: number;
    createdByUserId: string;
    reason?: string;
  },
): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .insert(payrollAdjustments)
      .values({
        tenantId,
        employeeId: args.employeeId,
        periodMonth: args.periodMonth,
        kind: args.kind,
        amount: String(args.amount),
        createdByUserId: args.createdByUserId,
        reason: args.reason ?? null,
      })
      .returning({ id: payrollAdjustments.id });
    return row.id;
  });
}

/* ─────────────────────── Direct peek helpers ─────────────────────────── */

export async function peekPeriodRows(
  tenantId: string,
  employeeId: string,
): Promise<Array<{ id: string; status: string; grossAmount: string; netAmount: string }>> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: payrollPeriods.id,
        status: payrollPeriods.status,
        grossAmount: payrollPeriods.grossAmount,
        netAmount: payrollPeriods.netAmount,
      })
      .from(payrollPeriods)
      .where(sql`${payrollPeriods.tenantId} = ${tenantId} and ${payrollPeriods.employeeId} = ${employeeId}`)
      .orderBy(sql`${payrollPeriods.periodStart} asc`);
    return rows;
  });
}
