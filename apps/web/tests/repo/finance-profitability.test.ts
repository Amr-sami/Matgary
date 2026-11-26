// Final closure — profitability + trends integration test.
//
// Seeds a tenant with sales (discounted, multi-item, partial return) and
// asserts the aggregated product/category profit numbers + the trend series
// exactly match hand-computed values. Also proves historical COGS is used
// (changing the product's current cost after the sale doesn't change the
// profit).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  branches,
  categories,
  products,
  returns as returnsTable,
  sales as salesTable,
  shopSettings,
  tenants,
  tenantMembers,
  users,
} from "@/lib/db/schema";
import {
  computeCategoryProfitability,
  computeProductProfitability,
} from "@/lib/finance/profitability";
import { computeTrend } from "@/lib/finance/trends";

let tenantA: {
  tenantId: string;
  userId: string;
  branchId: string;
  categoryId: string;
  productAId: string;
  productBId: string;
};
let tenantB: { tenantId: string };

const PERIOD = {
  from: new Date("2026-06-01T00:00:00.000Z"),
  to: new Date("2026-07-01T00:00:00.000Z"),
};

async function freshTenant(suffix: string) {
  return db.transaction(async (tx) => {
    const email = `prof-${suffix}-${Date.now()}@test.local`;
    const [u] = await tx
      .insert(users)
      .values({ email, name: `Prof ${suffix}`, passwordHash: "x" })
      .returning({ id: users.id });
    const [t] = await tx
      .insert(tenants)
      .values({
        name: `Prof ${suffix}`,
        slug: `prof-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
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
      shopName: `Prof ${suffix}`,
    });
    const [cat] = await tx
      .insert(categories)
      .values({ tenantId: t.id, branchId: b.id, key: "general", label: "General" })
      .returning({ id: categories.id });
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

async function insertSale(
  t: typeof tenantA,
  productId: string,
  opts: {
    saleDate: Date;
    quantity: number;
    pricePerUnit: number;
    costPriceAtSale: number;
    discountAmount?: number;
    brand?: string;
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
        productName: productId === t.productAId ? "Product A" : "Product B",
        categoryId: t.categoryId,
        brand: opts.brand ?? null,
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
  t: typeof tenantA,
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

beforeAll(async () => {
  tenantA = await freshTenant("a");
  tenantB = await freshTenant("b");

  // Seed A — 3 Product-A sales + 2 Product-B sales + a partial return.
  //   1. 2 × A @ 1000 (snapshot cost 600), 100 discount
  //   2. 1 × A @ 1000 (snapshot cost 600), no discount
  //   3. 3 × A @ 1000 (snapshot cost 600), then return 1 of 3
  //   4. 4 × B @ 500 (snapshot cost 300), 200 discount
  //   5. 2 × B @ 500 (snapshot cost 300), no discount
  await insertSale(tenantA, tenantA.productAId, {
    saleDate: new Date("2026-06-05T10:00:00.000Z"),
    quantity: 2,
    pricePerUnit: 1000,
    costPriceAtSale: 600,
    discountAmount: 100,
  });
  await insertSale(tenantA, tenantA.productAId, {
    saleDate: new Date("2026-06-10T10:00:00.000Z"),
    quantity: 1,
    pricePerUnit: 1000,
    costPriceAtSale: 600,
  });
  const saleWithReturn = await insertSale(tenantA, tenantA.productAId, {
    saleDate: new Date("2026-06-12T10:00:00.000Z"),
    quantity: 3,
    pricePerUnit: 1000,
    costPriceAtSale: 600,
  });
  await insertReturn(tenantA, saleWithReturn, {
    returnedQuantity: 1,
    returnDate: new Date("2026-06-20T10:00:00.000Z"),
  });
  await insertSale(tenantA, tenantA.productBId, {
    saleDate: new Date("2026-06-18T10:00:00.000Z"),
    quantity: 4,
    pricePerUnit: 500,
    costPriceAtSale: 300,
    discountAmount: 200,
  });
  await insertSale(tenantA, tenantA.productBId, {
    saleDate: new Date("2026-06-22T10:00:00.000Z"),
    quantity: 2,
    pricePerUnit: 500,
    costPriceAtSale: 300,
  });
});

afterAll(async () => {
  if (tenantA?.tenantId) await db.execute(sql`delete from tenants where id = ${tenantA.tenantId}`);
  if (tenantB?.tenantId) await db.execute(sql`delete from tenants where id = ${tenantB.tenantId}`);
});

describe("Profitability — product", () => {
  it("per-product revenue + COGS + gross profit are computed from the snapshot", async () => {
    const { rows } = await computeProductProfitability(tenantA.tenantId, PERIOD, {
      sort: "grossProfit",
    });
    expect(rows.length).toBe(2);
    const a = rows.find((r) => r.productId === tenantA.productAId)!;
    const b = rows.find((r) => r.productId === tenantA.productBId)!;

    // Product A (hand-math):
    //   Sales: 2×1000 + 1×1000 + 3×1000 = 6000 revenue (subtotals)
    //   Discounts: 100
    //   Revenue = 5900 (netted on subtotal − discount per line)
    //   Return: 1 of 3 on the third sale.
    //     Revenue reversal = (1/3) × (totalPrice = 3000) = 1000
    //     Net revenue = 5900 − 1000 = 4900
    //     COGS forward = (2 + 1 + 3) × 600 = 3600
    //     COGS reversal = 1 × 600 = 600
    //     Net COGS = 3000
    //   Gross profit = 4900 − 3000 = 1900
    //   Margin = 1900/4900
    expect(a.quantitySold).toBe(2 + 1 + 3 - 1);
    expect(a.revenue).toBeCloseTo(4900, 2);
    expect(a.cogs).toBeCloseTo(3000, 2);
    expect(a.grossProfit).toBeCloseTo(1900, 2);
    expect(a.margin).toBeCloseTo(1900 / 4900, 4);

    // Product B:
    //   4 × 500 − 200 discount + 2 × 500 = 2000 − 200 + 1000 = 2800 revenue
    //   COGS = 6 × 300 = 1800
    //   Gross = 1000
    expect(b.quantitySold).toBe(6);
    expect(b.revenue).toBeCloseTo(2800, 2);
    expect(b.cogs).toBeCloseTo(1800, 2);
    expect(b.grossProfit).toBeCloseTo(1000, 2);
  });

  it("historical COGS is used — changing products.costPrice AFTER the sale does NOT affect profit", async () => {
    // Change the current product cost — snapshots on sales rows must NOT follow.
    await withTenant(tenantA.tenantId, (tx) =>
      tx
        .update(products)
        .set({ costPrice: "900.00" })
        .where(
          and(
            eq(products.tenantId, tenantA.tenantId),
            eq(products.id, tenantA.productAId),
          ),
        ),
    );
    const { rows } = await computeProductProfitability(tenantA.tenantId, PERIOD, {});
    const a = rows.find((r) => r.productId === tenantA.productAId)!;
    // Still 3000, not 900 × 5 = 4500.
    expect(a.cogs).toBeCloseTo(3000, 2);
    expect(a.grossProfit).toBeCloseTo(1900, 2);
  });

  it("respects sort=revenue vs sort=grossProfit", async () => {
    const byRev = await computeProductProfitability(tenantA.tenantId, PERIOD, {
      sort: "revenue",
    });
    expect(byRev.rows[0].productId).toBe(tenantA.productAId); // 4900 > 2800
    const byProfit = await computeProductProfitability(tenantA.tenantId, PERIOD, {
      sort: "grossProfit",
    });
    expect(byProfit.rows[0].productId).toBe(tenantA.productAId); // 1900 > 1000
  });

  it("tenant isolation — tenant B sees zero rows", async () => {
    const { rows } = await computeProductProfitability(tenantB.tenantId, PERIOD, {});
    expect(rows).toHaveLength(0);
  });
});

describe("Profitability — category", () => {
  it("aggregates every product under its category", async () => {
    const rows = await computeCategoryProfitability(tenantA.tenantId, PERIOD, {
      sort: "revenue",
    });
    expect(rows).toHaveLength(1);
    // One category in this seed — revenue is sum of A + B.
    expect(rows[0].revenue).toBeCloseTo(4900 + 2800, 2);
    expect(rows[0].cogs).toBeCloseTo(3000 + 1800, 2);
    expect(rows[0].grossProfit).toBeCloseTo(1900 + 1000, 2);
  });
});

describe("Trends", () => {
  it("day bucket: non-empty for days with sales, zero-filled for the rest", async () => {
    const { bucket, data } = await computeTrend(tenantA.tenantId, PERIOD);
    expect(bucket).toBe("day");
    // 30 days in June → 30 points.
    expect(data.length).toBe(30);
    // Totals must match hand-math:
    //   Revenue (Σ subtotal): 6000 (A) + 3000 (B lines) = 9000
    //   Discounts: 100 (A) + 200 (B) = 300
    //   Returns revenue reversal: 1000 (from one Product-A sale)
    //   Net sales = 9000 − 300 − 1000 = 7700
    //   COGS forward: 3600 (A) + 1800 (B) = 5400
    //   COGS reversal: 600
    //   Net COGS = 4800
    //   Gross profit = 7700 − 4800 = 2900
    const totals = data.reduce(
      (acc, p) => ({
        revenue: acc.revenue + p.revenue,
        discounts: acc.discounts + p.discounts,
        returnsRevenue: acc.returnsRevenue + p.returnsRevenue,
        netSales: acc.netSales + p.netSales,
        cogs: acc.cogs + p.cogs,
        grossProfit: acc.grossProfit + p.grossProfit,
      }),
      { revenue: 0, discounts: 0, returnsRevenue: 0, netSales: 0, cogs: 0, grossProfit: 0 },
    );
    expect(totals.revenue).toBeCloseTo(9000, 2);
    expect(totals.discounts).toBeCloseTo(300, 2);
    expect(totals.returnsRevenue).toBeCloseTo(1000, 2);
    expect(totals.netSales).toBeCloseTo(7700, 2);
    expect(totals.cogs).toBeCloseTo(4800, 2);
    expect(totals.grossProfit).toBeCloseTo(2900, 2);
  });

  it("every numeric field in every point is finite (no NaN)", async () => {
    const { data } = await computeTrend(tenantA.tenantId, PERIOD);
    for (const p of data) {
      for (const [k, v] of Object.entries(p)) {
        if (typeof v === "number") {
          expect(Number.isFinite(v), `${p.date}.${k}`).toBe(true);
        }
      }
    }
  });

  it("tenant isolation — tenant B trend has zero totals", async () => {
    const { data } = await computeTrend(tenantB.tenantId, PERIOD);
    const totals = data.reduce((s, p) => s + p.revenue, 0);
    expect(totals).toBe(0);
  });
});
