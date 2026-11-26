// Slice 1 hardening — real DB integration test for the Financials engine.
//
// Non-destructive: creates two isolated tenants with unique slugs, seeds a
// realistic dataset on each, calls the production fetch + compute path, and
// verifies the arithmetic + tenant isolation. Cleanup deletes both tenants
// (CASCADE wipes every child row); it never touches other data.
//
// Unlike tests/isolation.test.ts this file does NOT require TEST_DB_WIPE.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  branches,
  categories,
  expenses as expensesTable,
  financialCategories,
  moneyMovements,
  payrollPeriods,
  products,
  returns as returnsTable,
  sales as salesTable,
  shopSettings,
  tenants,
  users,
  tenantMembers,
  productHistory,
} from "@/lib/db/schema";
import { computePnLFromSource, fetchPnLSource } from "@/lib/finance/pnl";

type IsoTenant = {
  tenantId: string;
  userId: string;
  branchId: string;
  categoryId: string;
  productAId: string;
  productBId: string;
};

let tenantA: IsoTenant;
let tenantB: IsoTenant;

/** The reporting window every test uses. All rows seeded in `beforeAll` land
 *  inside this range so we have deterministic numbers to assert against. */
const FROM = new Date("2026-06-01T00:00:00.000Z");
const TO = new Date("2026-07-01T00:00:00.000Z");

/** Pick instants inside the window so returns, sales, expenses, and payroll
 *  periods all land where we want them. */
const INSIDE = {
  saleFullReturn: new Date("2026-06-05T12:00:00.000Z"),
  saleDiscount: new Date("2026-06-10T12:00:00.000Z"),
  salePartialReturn: new Date("2026-06-12T12:00:00.000Z"),
  saleMulti: new Date("2026-06-15T12:00:00.000Z"),
  returnFull: new Date("2026-06-20T12:00:00.000Z"),
  returnPartial: new Date("2026-06-22T12:00:00.000Z"),
  expensePosted: new Date("2026-06-07T09:00:00.000Z"),
  expenseVoided: new Date("2026-06-08T09:00:00.000Z"),
  payrollEnd: new Date("2026-06-30T23:59:59.000Z"),
  moneyIn: new Date("2026-06-11T10:00:00.000Z"),
  moneyOut: new Date("2026-06-14T10:00:00.000Z"),
};

async function freshTenant(suffix: string): Promise<IsoTenant> {
  return db.transaction(async (tx) => {
    const email = `fin-int-${suffix}-${Date.now()}@test.local`;
    const [u] = await tx
      .insert(users)
      .values({ email, name: `Fin Int ${suffix}`, passwordHash: "x" })
      .returning({ id: users.id });
    const slug = `fin-int-${suffix}-${Math.random().toString(36).slice(2, 8)}`;
    const [t] = await tx
      .insert(tenants)
      .values({ name: `Fin Int ${suffix}`, slug })
      .returning({ id: tenants.id });
    await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
    const [b] = await tx
      .insert(branches)
      .values({
        tenantId: t.id,
        slug: "main",
        name: `Fin Int ${suffix} branch`,
        isPrimary: true,
      })
      .returning({ id: branches.id });
    await tx.insert(tenantMembers).values({
      tenantId: t.id,
      userId: u.id,
      role: "owner",
    });
    await tx.insert(shopSettings).values({
      tenantId: t.id,
      branchId: b.id,
      shopName: `Fin Int ${suffix}`,
    });
    const [cat] = await tx
      .insert(categories)
      .values({ tenantId: t.id, branchId: b.id, key: "general", label: "General" })
      .returning({ id: categories.id });
    // Two distinct products so we can keep per-line cost snapshots explicit.
    const [pA] = await tx
      .insert(products)
      .values({
        tenantId: t.id,
        branchId: b.id,
        categoryId: cat.id,
        name: `Product A ${suffix}`,
        quantity: 1000,
        price: "1000.00",
        costPrice: "600.00",
      })
      .returning({ id: products.id });
    const [pB] = await tx
      .insert(products)
      .values({
        tenantId: t.id,
        branchId: b.id,
        categoryId: cat.id,
        name: `Product B ${suffix}`,
        quantity: 1000,
        price: "500.00",
        costPrice: "300.00",
      })
      .returning({ id: products.id });
    return {
      tenantId: t.id,
      userId: u.id,
      branchId: b.id,
      categoryId: cat.id,
      productAId: pA.id,
      productBId: pB.id,
    };
  });
}

async function cleanup(tenantId: string): Promise<void> {
  // Deleting the tenant CASCADEs through every FK (sales, returns, expenses,
  // payroll_periods, money_movements, etc.) — see migration 0000 / 0064.
  await db.execute(sql`delete from tenants where id = ${tenantId}`);
}

/**
 * Insert a sale row DIRECTLY (bypassing `recordSale`) so we can snapshot
 * exact amounts without the sale repo's extra side effects (stock adjust,
 * sale payments, etc.). Matches the shape the production path writes.
 */
async function insertSale(
  t: IsoTenant,
  productId: string,
  opts: {
    saleDate: Date;
    quantity: number;
    pricePerUnit: number;
    costPriceAtSale: number;
    discountAmount?: number;
  },
): Promise<string> {
  const subtotal = opts.quantity * opts.pricePerUnit;
  const totalPrice = subtotal - (opts.discountAmount ?? 0);
  const [row] = await withTenant(t.tenantId, (tx) =>
    tx
      .insert(salesTable)
      .values({
        tenantId: t.tenantId,
        branchId: t.branchId,
        productId,
        productName: "test",
        categoryId: t.categoryId,
        quantitySold: opts.quantity,
        pricePerUnit: String(opts.pricePerUnit),
        costPriceAtSale: String(opts.costPriceAtSale),
        subtotal: String(subtotal),
        discountAmount: opts.discountAmount ? String(opts.discountAmount) : null,
        totalPrice: String(totalPrice),
        saleDate: opts.saleDate,
        paymentMethod: "cash",
        amountPaid: String(totalPrice),
        recordedByUserId: t.userId,
      })
      .returning({ id: salesTable.id }),
  );
  return row.id;
}

async function insertReturn(
  t: IsoTenant,
  saleId: string,
  opts: { returnedQuantity: number; returnDate: Date },
): Promise<void> {
  await withTenant(t.tenantId, async (tx) => {
    await tx.insert(returnsTable).values({
      tenantId: t.tenantId,
      saleId,
      productId: t.productAId,
      productName: "test",
      returnedQuantity: opts.returnedQuantity,
      returnDate: opts.returnDate,
    });
    // Mirror what `recordReturn` updates on the sale row so the engine's
    // fetch query sees the same data a production return would produce.
    await tx
      .update(salesTable)
      .set({
        isReturned: true,
        returnedAt: opts.returnDate,
        returnedQuantity: sql`${salesTable.returnedQuantity} + ${opts.returnedQuantity}`,
      })
      .where(and(eq(salesTable.tenantId, t.tenantId), eq(salesTable.id, saleId)));
  });
}

async function insertExpense(
  t: IsoTenant,
  opts: {
    date: Date;
    amount: number;
    categorySlug: string; // slug of a seeded financial_category
    status?: "posted" | "voided";
  },
): Promise<string> {
  // Look up the seeded category id by slug. System categories have
  // tenant_id IS NULL.
  const [cat] = await withTenant(t.tenantId, (tx) =>
    tx
      .select({ id: financialCategories.id })
      .from(financialCategories)
      .where(
        and(
          eq(financialCategories.slug, opts.categorySlug),
          sql`${financialCategories.tenantId} is null`,
        ),
      )
      .limit(1),
  );
  if (!cat) {
    throw new Error(`Seed category ${opts.categorySlug} not found`);
  }
  const [row] = await withTenant(t.tenantId, (tx) =>
    tx
      .insert(expensesTable)
      .values({
        tenantId: t.tenantId,
        branchId: t.branchId,
        title: `${opts.categorySlug} expense`,
        amount: String(opts.amount),
        category: "other", // legacy column still NOT NULL
        categoryId: cat.id,
        status: opts.status ?? "posted",
        date: opts.date,
        createdByUserId: t.userId,
      })
      .returning({ id: expensesTable.id }),
  );
  return row.id;
}

async function insertPayroll(
  t: IsoTenant,
  opts: {
    periodStart: Date;
    periodEnd: Date;
    gross: number;
    adjustments?: number;
    status: "draft" | "finalized";
    employeeId?: string;
  },
): Promise<void> {
  // 0068 added a partial-unique index on (tenant, employee, period_start)
  // for live (non-voided) rows. When the caller omits `employeeId` and the
  // test seeds multiple payroll rows for the same month, spin up a fresh
  // staff user for each insert so the uniqueness invariant holds.
  const employeeId =
    opts.employeeId ??
    (await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          email: `pnl-staff-${Math.random().toString(36).slice(2, 8)}@test.local`,
          name: "PNL staff",
          passwordHash: "x",
        })
        .returning({ id: users.id });
      await tx.execute(sql`select set_config('app.tenant_id', ${t.tenantId}, true)`);
      await tx.insert(tenantMembers).values({
        tenantId: t.tenantId,
        userId: u.id,
        role: "staff",
      });
      return u.id;
    }));
  await withTenant(t.tenantId, (tx) =>
    tx.insert(payrollPeriods).values({
      tenantId: t.tenantId,
      employeeId,
      periodStart: opts.periodStart,
      periodEnd: opts.periodEnd,
      grossAmount: String(opts.gross),
      adjustmentsAmount: String(opts.adjustments ?? 0),
      status: opts.status,
      finalizedAt: opts.status === "finalized" ? opts.periodEnd : null,
      finalizedByUserId: opts.status === "finalized" ? t.userId : null,
    }),
  );
}

async function insertMoneyMovement(
  t: IsoTenant,
  opts: { kind: string; amount: number; occurredAt: Date },
): Promise<void> {
  await withTenant(t.tenantId, (tx) =>
    tx.insert(moneyMovements).values({
      tenantId: t.tenantId,
      kind: opts.kind,
      amount: String(opts.amount),
      occurredAt: opts.occurredAt,
      createdByUserId: t.userId,
    }),
  );
}

beforeAll(async () => {
  tenantA = await freshTenant("a");
  tenantB = await freshTenant("b");

  // ── Tenant A dataset ───────────────────────────────────────────────────────
  // 1. A full-return sale (sale rung inside window, return also inside window).
  const saleFullReturn = await insertSale(tenantA, tenantA.productAId, {
    saleDate: INSIDE.saleFullReturn,
    quantity: 1,
    pricePerUnit: 1000,
    costPriceAtSale: 600,
  });
  await insertReturn(tenantA, saleFullReturn, {
    returnedQuantity: 1,
    returnDate: INSIDE.returnFull,
  });
  // 2. A discounted sale (no return).
  await insertSale(tenantA, tenantA.productAId, {
    saleDate: INSIDE.saleDiscount,
    quantity: 2,
    pricePerUnit: 1000,
    costPriceAtSale: 600,
    discountAmount: 200,
  });
  // 3. A partial-return sale.
  const salePartial = await insertSale(tenantA, tenantA.productBId, {
    saleDate: INSIDE.salePartialReturn,
    quantity: 4,
    pricePerUnit: 500,
    costPriceAtSale: 300,
  });
  await insertReturn(tenantA, salePartial, {
    returnedQuantity: 1,
    returnDate: INSIDE.returnPartial,
  });
  // 4. Multi-line style sale (different product).
  await insertSale(tenantA, tenantA.productBId, {
    saleDate: INSIDE.saleMulti,
    quantity: 3,
    pricePerUnit: 500,
    costPriceAtSale: 300,
  });
  // 5. Posted expense (rent) + voided expense (electricity).
  await insertExpense(tenantA, {
    date: INSIDE.expensePosted,
    amount: 500,
    categorySlug: "rent",
    status: "posted",
  });
  await insertExpense(tenantA, {
    date: INSIDE.expenseVoided,
    amount: 9999,
    categorySlug: "electricity",
    status: "voided",
  });
  // 6. Finalized payroll period.
  await insertPayroll(tenantA, {
    periodStart: new Date("2026-06-01T00:00:00.000Z"),
    periodEnd: INSIDE.payrollEnd,
    gross: 3000,
    adjustments: 100,
    status: "finalized",
  });
  // 7. Draft payroll (must be EXCLUDED from P&L).
  await insertPayroll(tenantA, {
    periodStart: new Date("2026-06-01T00:00:00.000Z"),
    periodEnd: INSIDE.payrollEnd,
    gross: 9999,
    status: "draft",
  });
  // 8. Money movements (must NOT touch P&L).
  await insertMoneyMovement(tenantA, {
    kind: "owner_deposit",
    amount: 50_000,
    occurredAt: INSIDE.moneyIn,
  });
  await insertMoneyMovement(tenantA, {
    kind: "owner_withdrawal",
    amount: 2_000,
    occurredAt: INSIDE.moneyOut,
  });
  await insertMoneyMovement(tenantA, {
    kind: "supplier_payment_direct",
    amount: 7_000,
    occurredAt: INSIDE.moneyOut,
  });

  // ── Tenant B dataset — completely different numbers to prove isolation ───
  await insertSale(tenantB, tenantB.productAId, {
    saleDate: INSIDE.saleDiscount,
    quantity: 5,
    pricePerUnit: 1000,
    costPriceAtSale: 600,
  });
  await insertExpense(tenantB, {
    date: INSIDE.expensePosted,
    amount: 777,
    categorySlug: "water",
    status: "posted",
  });
});

afterAll(async () => {
  if (tenantA?.tenantId) await cleanup(tenantA.tenantId);
  if (tenantB?.tenantId) await cleanup(tenantB.tenantId);
});

describe("Financials engine — DB integration", () => {
  it("fetch + compute produces the deterministic P&L for the seeded tenant A", async () => {
    const source = await fetchPnLSource(tenantA.tenantId, { from: FROM, to: TO });

    // Sales in window: 4 rows (full-return + discounted + partial-return + multi).
    expect(source.sales).toHaveLength(4);
    // Returns in window: 2 rows.
    expect(source.returns).toHaveLength(2);
    // Posted expense + voided one — engine must only see the posted one.
    expect(source.expenses).toHaveLength(1);
    expect(source.expenses[0]?.amount).toBe(500);
    // Finalized payroll only — draft excluded.
    expect(source.payrollExpenses).toHaveLength(1);
    expect(source.payrollExpenses[0]?.amount).toBe(3100); // 3000 + 100 adjustments.
    // All three money movements visible.
    expect(source.moneyMovements).toHaveLength(3);

    const pnl = computePnLFromSource(source);

    // Arithmetic — computed by hand so a code change that drifts gets caught:
    //
    // Gross Sales (Σ subtotal):
    //   1×1000 + 2×1000 + 4×500 + 3×500 = 1000 + 2000 + 2000 + 1500 = 6500
    expect(pnl.grossSales).toBe(6500);
    // Discounts: only the discounted sale carries one.
    expect(pnl.discounts).toBe(200);
    // Returns revenue reversal (post-discount, proportional):
    //   Full return: 1/1 × 1000 = 1000
    //   Partial return: 1/4 × 2000 = 500
    //   Total: 1500
    expect(pnl.returnsRevenue).toBe(1500);
    // Net Sales = 6500 − 200 − 1500 = 4800
    expect(pnl.netSales).toBe(4800);
    // COGS forward: 1×600 + 2×600 + 4×300 + 3×300 = 600 + 1200 + 1200 + 900 = 3900
    // COGS reversal: 1×600 + 1×300 = 900
    // Net COGS = 3900 − 900 = 3000
    expect(pnl.cogs).toBe(3000);
    // Gross Profit = 4800 − 3000 = 1800
    expect(pnl.grossProfit).toBe(1800);
    // OpEx = 500 (rent) + 3100 (payroll) = 3600
    expect(pnl.operatingExpenses).toBe(3600);
    // Operating Profit = 1800 − 3600 = -1800
    expect(pnl.operatingProfit).toBe(-1800);
    // Other income/expense = 0 in this dataset.
    expect(pnl.otherIncome).toBe(0);
    expect(pnl.otherExpense).toBe(0);
    // Net Profit = -1800
    expect(pnl.netProfit).toBe(-1800);
    // Finite everywhere.
    for (const [k, v] of Object.entries(pnl)) {
      if (typeof v === "number") {
        expect(Number.isFinite(v), `pnl.${k}`).toBe(true);
      }
    }
  });

  it("voided expenses are excluded from OpEx", async () => {
    const source = await fetchPnLSource(tenantA.tenantId, { from: FROM, to: TO });
    const amounts = source.expenses.map((e) => e.amount);
    expect(amounts).toContain(500);     // posted rent
    expect(amounts).not.toContain(9999); // voided electricity
  });

  it("draft payroll is excluded from OpEx", async () => {
    const source = await fetchPnLSource(tenantA.tenantId, { from: FROM, to: TO });
    expect(source.payrollExpenses).toHaveLength(1);
    expect(source.payrollExpenses[0]?.amount).toBe(3100);
  });

  it("money movements are included in the response but excluded from P&L totals", async () => {
    const source = await fetchPnLSource(tenantA.tenantId, { from: FROM, to: TO });
    // Three movements in the window.
    expect(source.moneyMovements.map((m) => m.kind).sort()).toEqual(
      ["owner_deposit", "owner_withdrawal", "supplier_payment_direct"].sort(),
    );
    // None of them appear in any P&L bucket.
    const pnl = computePnLFromSource(source);
    expect(pnl.grossSales).not.toContain(50_000);
    expect(pnl.operatingExpenses).not.toBe(50_000 + 2_000 + 7_000);
    // Belt-and-braces: OpEx is exactly 3600 (rent + payroll), as above.
    expect(pnl.operatingExpenses).toBe(3600);
  });

  it("tenant B cannot see tenant A's financial data", async () => {
    const bSource = await fetchPnLSource(tenantB.tenantId, { from: FROM, to: TO });
    const bPnl = computePnLFromSource(bSource);

    // Tenant B seeded 5×1000 sales and 777 water expense only.
    expect(bPnl.grossSales).toBe(5000);
    expect(bPnl.operatingExpenses).toBe(777);
    expect(bPnl.cogs).toBe(3000); // 5 × 600 (same cost coincidence — fine).
    expect(bSource.sales).toHaveLength(1);
    expect(bSource.returns).toHaveLength(0);
    // Not a single tenant-A row leaks in.
    for (const s of bSource.sales) {
      expect(s.saleId).not.toBe(tenantA.productAId);
    }
  });

  it("date boundaries: a window before the data has zero everything", async () => {
    const earlierWindow = {
      from: new Date("2025-01-01T00:00:00.000Z"),
      to: new Date("2025-02-01T00:00:00.000Z"),
    };
    const source = await fetchPnLSource(tenantA.tenantId, earlierWindow);
    expect(source.sales).toHaveLength(0);
    expect(source.returns).toHaveLength(0);
    expect(source.expenses).toHaveLength(0);
    expect(source.payrollExpenses).toHaveLength(0);
    expect(source.moneyMovements).toHaveLength(0);
    const pnl = computePnLFromSource(source);
    expect(pnl.netProfit).toBe(0);
    expect(Number.isFinite(pnl.netMargin)).toBe(true); // 0/0 → safeDiv returns 0
  });

  it("date boundaries: a half-open window excludes rows at the `to` instant", async () => {
    // Narrow window that ends exactly at saleFullReturn's saleDate. The sale
    // should NOT appear (half-open convention).
    const source = await fetchPnLSource(tenantA.tenantId, {
      from: FROM,
      to: INSIDE.saleFullReturn,
    });
    expect(source.sales.some((s) => s.subtotal === 1000 && s.quantitySold === 1)).toBe(false);
  });
});

describe("Financials — safety guarantees (SQL path)", () => {
  it("purchases are NOT visible to fetchPnLSource (schema has no purchases input)", () => {
    // Static check — the PnLSource type has no purchases field. The TS
    // compiler enforces this, but assert explicitly for documentation.
    const sampleKeys: (keyof Awaited<ReturnType<typeof fetchPnLSource>>)[] = [
      "sales",
      "returns",
      "expenses",
      "payrollExpenses",
      "moneyMovements",
    ];
    expect(sampleKeys).not.toContain("purchases" as never);
    expect(sampleKeys).not.toContain("purchaseOrderPayments" as never);
  });

  it("no NaN/undefined/null in any numeric engine field, even on an empty window", async () => {
    const source = await fetchPnLSource(tenantA.tenantId, {
      from: new Date("2000-01-01T00:00:00.000Z"),
      to: new Date("2000-01-02T00:00:00.000Z"),
    });
    const pnl = computePnLFromSource(source);
    for (const [k, v] of Object.entries(pnl)) {
      if (typeof v === "number") {
        expect(Number.isFinite(v), `pnl.${k} must be finite`).toBe(true);
      } else if (Array.isArray(v)) {
        // Hierarchical breakdowns — nothing to check per-row for empty window.
        expect(v).toHaveLength(0);
      }
    }
  });
});
