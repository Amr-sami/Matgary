/**
 * S7 — recordCartSale against the real repo (live test DB, same harness as
 * tests/isolation.test.ts). The route suite fakes the repo; this one pins
 * the server-side behaviour that only the DB can prove:
 *   - allowOversell:false → INSUFFICIENT_STOCK, nothing written;
 *   - one line past the shelf → product at 0, ONE stock_discrepancies row,
 *     and the product_history deltas SUM to the final quantity;
 *   - two lines of the same product → ONE discrepancy row with the
 *     aggregated request, ledger still reconciles;
 *   - a shelf already at 0 → still books, reconciles from 0.
 *
 * Needs DATABASE_URL to name a "test" database (skipped otherwise). Creates
 * its own tenant and never truncates, so it is safe next to isolation.test.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db, withTenant } from "@/lib/db";
import {
  branches,
  categories,
  productHistory,
  products,
  shopSettings,
  stockDiscrepancies,
  tenantMembers,
  tenants,
  users,
} from "@/lib/db/schema";
import { isDomainError } from "@/lib/errors";
import { addProduct } from "@/lib/repo/catalog";
import { recordCartSale } from "@/lib/repo/operations";
import { seedCornerStorePreset } from "@/lib/seeds/cornerstore";

const url = process.env.DATABASE_URL ?? "";
const hasTestDb = /test/i.test(url);

let tenantId: string;
let branchId: string;
let userId: string;
let categoryId: string;

async function freshProduct(quantity: number): Promise<string> {
  const { id } = await addProduct(tenantId, branchId, {
    name: `Oversell ${quantity}-${Math.random().toString(36).slice(2, 6)}`,
    categoryId,
    quantity,
    price: 10,
    lowStockThreshold: 0,
  });
  return id;
}

async function ledger(productId: string) {
  return withTenant(tenantId, async (tx) => {
    const [p] = await tx
      .select({ quantity: products.quantity })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, productId)));
    const history = await tx
      .select({ type: productHistory.type, delta: productHistory.delta, note: productHistory.note })
      .from(productHistory)
      .where(and(eq(productHistory.tenantId, tenantId), eq(productHistory.productId, productId)));
    const discrepancies = await tx
      .select()
      .from(stockDiscrepancies)
      .where(and(eq(stockDiscrepancies.tenantId, tenantId), eq(stockDiscrepancies.productId, productId)));
    return {
      quantity: p?.quantity ?? NaN,
      history,
      // addProduct writes a "created" row carrying the opening quantity, so
      // the whole trail (opening + sold + reconciled) must equal the shelf.
      sum: history.reduce((s, h) => s + (h.delta ?? 0), 0),
      discrepancies,
    };
  });
}

function sell(productId: string, quantities: number[], allowOversell: boolean, invoiceId: string) {
  return recordCartSale(
    tenantId,
    quantities.map((quantity) => ({ productId, quantity, pricePerUnit: 10 })),
    { branchId, recordedByUserId: userId, recordedByRole: "owner", paymentMethod: "cash", invoiceId, allowOversell },
  );
}

beforeAll(async () => {
  if (!hasTestDb) return;
  const made = await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email: `oversell-${Date.now()}@iso.test`, name: "Oversell", passwordHash: "x" })
      .returning({ id: users.id });
    const [t] = await tx
      .insert(tenants)
      .values({ name: "Oversell", slug: `ovs-${Math.random().toString(36).slice(2, 8)}` })
      .returning({ id: tenants.id });
    await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
    const [b] = await tx
      .insert(branches)
      .values({ tenantId: t.id, slug: "main", name: "الفرع الرئيسي", isPrimary: true })
      .returning({ id: branches.id });
    await tx.insert(tenantMembers).values({ tenantId: t.id, userId: u.id, role: "owner" });
    await tx.insert(shopSettings).values({ tenantId: t.id, branchId: b.id, shopName: "Oversell" });
    await seedCornerStorePreset(tx, t.id, b.id);
    return { tenantId: t.id, userId: u.id, branchId: b.id };
  });
  tenantId = made.tenantId;
  userId = made.userId;
  branchId = made.branchId;
  const cats = await withTenant(tenantId, (tx) =>
    tx.select({ id: categories.id }).from(categories).where(eq(categories.tenantId, tenantId)).limit(1),
  );
  categoryId = cats[0]!.id;
});

describe.skipIf(!hasTestDb)("recordCartSale — S7 oversell against the DB", () => {
  it("allowOversell:false → INSUFFICIENT_STOCK and nothing written", async () => {
    const productId = await freshProduct(1);
    let code: string | null = null;
    try {
      await sell(productId, [3], false, "INV-OVS-REFUSED");
    } catch (err) {
      code = isDomainError(err) ? err.code : String(err);
    }
    expect(code).toBe("INSUFFICIENT_STOCK");
    const l = await ledger(productId);
    expect(l.quantity).toBe(1);
    expect(l.history.map((h) => h.type)).toEqual(["created"]);
    expect(l.discrepancies).toHaveLength(0);
  });

  it("single line past the shelf: qty 0, one discrepancy row, ledger sums to 0", async () => {
    const productId = await freshProduct(1);
    const result = await sell(productId, [3], true, "INV-OVS-SINGLE");
    expect(result.oversold).toEqual([{ productId, productName: expect.any(String), requested: 3, available: 1 }]);
    const l = await ledger(productId);
    expect(l.quantity).toBe(0);
    expect(l.sum).toBe(l.quantity);
    expect(l.history.map((h) => [h.type, h.delta])).toEqual([["created", 1], ["sold", -3], ["restocked", 2]]);
    expect(l.history[2]?.note).toBe("oversell: requested 3, available 1, offline sale INV-OVS-SINGLE");
    expect(l.discrepancies).toHaveLength(1);
    expect(l.discrepancies[0]).toMatchObject({ invoiceId: "INV-OVS-SINGLE", requested: 3, available: 1, branchId, recordedByUserId: userId });
  });

  it("two lines of the same product: one discrepancy row with the aggregated request", async () => {
    const productId = await freshProduct(1);
    const result = await sell(productId, [2, 2], true, "INV-OVS-SPLIT");
    expect(result.oversold).toHaveLength(1);
    expect(result.oversold[0]).toMatchObject({ requested: 4, available: 1 });
    const l = await ledger(productId);
    expect(l.quantity).toBe(0);
    expect(l.sum).toBe(0);
    expect(l.history.map((h) => [h.type, h.delta])).toEqual([["created", 1], ["sold", -2], ["sold", -2], ["restocked", 3]]);
    expect(l.discrepancies).toHaveLength(1);
    expect(l.discrepancies[0]).toMatchObject({ requested: 4, available: 1 });
  });

  it("a shelf already at 0 still books and reconciles", async () => {
    const productId = await freshProduct(0);
    await sell(productId, [2], true, "INV-OVS-ZERO");
    const l = await ledger(productId);
    expect(l.quantity).toBe(0);
    expect(l.sum).toBe(0);
    expect(l.discrepancies[0]).toMatchObject({ requested: 2, available: 0 });
  });
});
