// Payroll V1 — Financials integration + double-count protection.
//
// Three guarantees being proved here:
//
//  1. DRAFT payroll does NOT roll into operating expenses.
//  2. FINALIZED payroll rolls in at (grossAmount + adjustmentsAmount), which
//     the P&L reader has been using since Slice 1.
//  3. Manual expenses under the People category group are rejected after
//     a payroll month is finalized — no double-counting.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, and, sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { financialCategories } from "@/lib/db/schema";
import {
  PayrollDoubleCountError,
  createFinanceExpense,
} from "@/lib/finance/expense-mutations";
import { fetchPnLSource, computePnLFromSource } from "@/lib/finance/pnl";
import {
  finalizePayrollPeriod,
  upsertPayrollDraft,
  voidPayrollPeriod,
} from "@/lib/repo/payroll-periods";
import {
  addShift,
  addStaff,
  seedPayrollTenant,
  setCompensation,
  type PayrollTenantSeed,
} from "./payroll-fixtures";

let seed: PayrollTenantSeed;
let employeeId: string;
const MONTH = new Date("2026-03-01T00:00:00Z");
const WINDOW = {
  from: new Date("2026-03-01T00:00:00Z"),
  to: new Date("2026-04-01T00:00:00Z"),
};

/** Resolve the id of the seeded "salaries" category (opex > People > Salaries).
 *  Lookup goes through `withTenant` so the RLS cast on `app.tenant_id`
 *  evaluates against a real uuid. */
async function salariesCategoryId(): Promise<string> {
  const [row] = await withTenant(seed.tenantId, (tx) =>
    tx
      .select({ id: financialCategories.id })
      .from(financialCategories)
      .where(
        and(
          eq(financialCategories.slug, "salaries"),
          sql`${financialCategories.tenantId} is null`,
        ),
      )
      .limit(1),
  );
  if (!row) throw new Error("seeded 'salaries' category missing");
  return row.id;
}

beforeAll(async () => {
  seed = await seedPayrollTenant("fin-v1");
  employeeId = await addStaff(seed.tenantId, { name: "P&L Pedro" });
  await setCompensation(seed.tenantId, {
    employeeId,
    createdByUserId: seed.ownerId,
    payType: "fixed",
    base: 3100,
  });
  // One full-day shift so grossAmount > 0.
  await addShift(seed.tenantId, {
    employeeId,
    recordedByUserId: seed.ownerId,
    start: new Date("2026-03-02T08:00:00Z"),
    end: new Date("2026-03-02T16:00:00Z"),
  });
});

afterAll(async () => {
  await seed.cleanup();
});

describe("DRAFT does not feed P&L; FINALIZED does", () => {
  it("DRAFT payroll is excluded from operating expenses", async () => {
    const draft = await upsertPayrollDraft(seed.tenantId, employeeId, MONTH);
    expect(draft.lifecycle).toBe("DRAFT");
    const src = await fetchPnLSource(seed.tenantId, WINDOW);
    expect(src.payrollExpenses).toHaveLength(0);
    const pnl = computePnLFromSource(src);
    expect(pnl.operatingExpenses).toBe(0);
  });

  it("FINALIZED payroll shows up as operating expense (gross + adjustments)", async () => {
    const sheet = await finalizePayrollPeriod(
      seed.tenantId,
      employeeId,
      MONTH,
      seed.ownerId,
    );
    expect(sheet.lifecycle).toBe("FINALIZED");
    const src = await fetchPnLSource(seed.tenantId, WINDOW);
    expect(src.payrollExpenses).toHaveLength(1);
    // The P&L reader uses grossAmount + adjustmentsAmount (legacy column);
    // our repo mirrors adjustmentsTotal onto adjustmentsAmount at upsert
    // time. Both sides agree.
    const expected = sheet.snapshot.grossAmount + sheet.snapshot.adjustmentsTotal;
    expect(src.payrollExpenses[0]?.amount).toBeCloseTo(expected, 2);
  });
});

describe("double-count guard on manual 'Salaries' expense", () => {
  it("manual People-category expense IS rejected when payroll is finalized", async () => {
    const categoryId = await salariesCategoryId();
    await expect(
      createFinanceExpense(seed.tenantId, {
        title: "Manual salary attempt",
        amount: 1000,
        date: new Date("2026-03-15T12:00:00Z"),
        categoryId,
        createdByUserId: seed.ownerId,
      }),
    ).rejects.toBeInstanceOf(PayrollDoubleCountError);
  });

  it("the guard does NOT reject a People-category expense for a month WITHOUT a finalized payroll", async () => {
    const categoryId = await salariesCategoryId();
    // Different month → no finalized row → should succeed.
    const res = await createFinanceExpense(seed.tenantId, {
      title: "Ad-hoc salary for an unfinalized month",
      amount: 1000,
      date: new Date("2026-05-15T12:00:00Z"),
      categoryId,
      createdByUserId: seed.ownerId,
    });
    expect(res.id).toBeTruthy();
  });

  it("the guard does NOT reject a NON-People-category expense in a finalized month", async () => {
    // Find the "rent" category (opex > Rent & Facilities > Rent).
    const [cat] = await withTenant(seed.tenantId, (tx) =>
      tx
        .select({ id: financialCategories.id })
        .from(financialCategories)
        .where(
          and(
            eq(financialCategories.slug, "rent"),
            sql`${financialCategories.tenantId} is null`,
          ),
        )
        .limit(1),
    );
    expect(cat).toBeTruthy();
    const res = await createFinanceExpense(seed.tenantId, {
      title: "March rent",
      amount: 5000,
      date: new Date("2026-03-15T12:00:00Z"),
      categoryId: cat!.id,
      createdByUserId: seed.ownerId,
    });
    expect(res.id).toBeTruthy();
  });

  it("after voiding the finalized sheet, the manual People-category post is accepted again", async () => {
    // Find the finalized row to void. Pass the Date as ISO text so the
    // underlying driver doesn't blow up trying to serialize a Date into the
    // raw template literal.
    const monthIso = MONTH.toISOString();
    const result = await withTenant(seed.tenantId, (tx) =>
      tx.execute(sql`
        select id from payroll_periods
        where tenant_id = ${seed.tenantId}::uuid
          and employee_id = ${employeeId}::uuid
          and period_start = ${monthIso}::timestamptz
          and status = 'finalized'
        limit 1
      `),
    );
    const row = (result as unknown as Array<{ id: string }>)[0];
    expect(row).toBeTruthy();
    await voidPayrollPeriod(
      seed.tenantId,
      row.id,
      seed.ownerId,
      "cleanup for guard test",
    );
    const categoryId = await salariesCategoryId();
    const res = await createFinanceExpense(seed.tenantId, {
      title: "Manual salary after void",
      amount: 1000,
      date: new Date("2026-03-20T12:00:00Z"),
      categoryId,
      createdByUserId: seed.ownerId,
    });
    expect(res.id).toBeTruthy();
  });
});
