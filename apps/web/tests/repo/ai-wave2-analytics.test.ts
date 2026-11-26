// Phase B P1 Wave 2 — authoritative analytics, real Postgres.
//
// Covers all nine new tools end-to-end through executeTool, plus cross-tenant
// isolation and permission gating:
//   • get_inventory_value
//   • get_dead_stock_products
//   • get_zero_cost_products
//   • get_average_basket_size
//   • get_sales_by_hour
//   • get_sales_by_day_of_week
//   • get_new_customers
//   • get_inactive_customers
//   • get_supplier_price_history
//
// Each suite uses its own seeded tenant (payroll-fixtures pattern) so the
// parallel vitest fork model doesn't let suites collide on tenant-scoped
// state.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  categories,
  products,
  purchaseOrderItems,
  purchaseOrders,
  sales,
  suppliers,
} from "@/lib/db/schema";
import { executeTool } from "@/lib/ai/tools";
import type { AgentContext } from "@/lib/ai/context";
import {
  seedPayrollTenant,
  seedProduct,
  type PayrollTenantSeed,
} from "./payroll-fixtures";

/* ────────────────────────────── helpers ─────────────────────────────── */

function ctxWith(
  t: PayrollTenantSeed,
  role: "owner" | "staff",
  perms: string[],
): AgentContext {
  return {
    tenantId: t.tenantId,
    userId: t.ownerId,
    branchId: null,
    role,
    permissions: perms,
    locale: "en",
  } as AgentContext;
}

const DEFAULT_PERMS = [
  "view_inventory",
  "view_sales",
  "view_customers",
  "view_suppliers",
  "view_purchases",
  "view_insights",
];

function ownerCtx(t: PayrollTenantSeed): AgentContext {
  return ctxWith(t, "owner", DEFAULT_PERMS);
}

function unprivilegedCtx(t: PayrollTenantSeed): AgentContext {
  return ctxWith(t, "staff", []);
}

async function freshSupplier(seed: PayrollTenantSeed, name: string): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${seed.tenantId}, true)`);
    const [s] = await tx
      .insert(suppliers)
      .values({
        tenantId: seed.tenantId,
        branchId: seed.branchId,
        name,
        phone: `+2010${Math.random().toString().slice(2, 10)}`,
      })
      .returning({ id: suppliers.id });
    return s.id;
  });
}

async function freshCategory(seed: PayrollTenantSeed, key: string, label: string) {
  return withTenant(seed.tenantId, async (tx) => {
    const [c] = await tx
      .insert(categories)
      .values({
        tenantId: seed.tenantId,
        branchId: seed.branchId,
        key,
        label,
        position: 1,
      })
      .returning({ id: categories.id });
    return c.id;
  });
}

async function setProductQuantity(
  tenantId: string,
  productId: string,
  qty: number,
  cost: number | null,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(products)
      .set({
        quantity: qty,
        costPrice: cost == null ? null : String(cost),
      })
      .where(and(eq(products.tenantId, tenantId), eq(products.id, productId)));
  });
}

async function insertSale(
  seed: PayrollTenantSeed,
  args: {
    productId: string;
    totalPrice: number;
    quantity?: number;
    saleDate: Date;
    customerPhone?: string | null;
    customerName?: string | null;
    isReturned?: boolean;
    invoiceId?: string | null;
  },
): Promise<string> {
  return withTenant(seed.tenantId, async (tx) => {
    const qty = args.quantity ?? 1;
    const [row] = await tx
      .insert(sales)
      .values({
        tenantId: seed.tenantId,
        branchId: seed.branchId,
        invoiceId: args.invoiceId ?? null,
        productId: args.productId,
        productName: "Test product",
        categoryId: seed.categoryId,
        quantitySold: qty,
        pricePerUnit: String(args.totalPrice / qty),
        subtotal: String(args.totalPrice),
        totalPrice: String(args.totalPrice),
        saleDate: args.saleDate,
        isReturned: args.isReturned ?? false,
        paymentMethod: "cash",
        isPaid: true,
        amountPaid: String(args.totalPrice),
        customerPhone: args.customerPhone ?? null,
        customerName: args.customerName ?? null,
      })
      .returning({ id: sales.id });
    return row.id;
  });
}

async function insertPOWithItems(
  seed: PayrollTenantSeed,
  supplierId: string,
  orderDate: Date,
  items: Array<{ productId: string | null; productName: string; unitCost: number; quantity: number }>,
): Promise<string> {
  const total = items.reduce((s, i) => s + i.unitCost * i.quantity, 0);
  return withTenant(seed.tenantId, async (tx) => {
    const [po] = await tx
      .insert(purchaseOrders)
      .values({
        tenantId: seed.tenantId,
        branchId: seed.branchId,
        supplierId,
        status: "received",
        total: String(total),
        paidAmount: "0",
        orderDate,
        receivedDate: orderDate,
      })
      .returning({ id: purchaseOrders.id });
    for (const it of items) {
      await tx.insert(purchaseOrderItems).values({
        tenantId: seed.tenantId,
        purchaseOrderId: po.id,
        productId: it.productId,
        productName: it.productName,
        quantity: it.quantity,
        unitCost: String(it.unitCost),
        lineTotal: String(it.unitCost * it.quantity),
      });
    }
    return po.id;
  });
}

/* ────────────────────────────── setup ───────────────────────────────── */

let A: PayrollTenantSeed;
let B: PayrollTenantSeed;
let watchesCategory: string;
let perfumesCategory: string;
let watchA: string;
let watchDead: string;
let watchNeverSold: string;
let perfumeZeroCost: string;
let perfumeNullCost: string;
let productInB: string;
let supplierHussein: string;
let supplierHusseinB: string;
const CUSTOMER_FATMA = "+201111111111";
const CUSTOMER_AHMED = "+201222222222";
const CUSTOMER_SARA = "+201333333333";
const CUSTOMER_INACTIVE = "+201444444444";

// "Recent" fixtures are anchored to NOW (suite run time) so dead-stock
// thresholds + inactivity windows apply consistently regardless of calendar
// date. For date-range assertions we compute `from`/`to` from the fixture
// timestamps rather than hard-coding months.
const ONE_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();

// Recent window = [NOW - 20 days, NOW - 1 day] — these sales are all recent
// enough that dead-stock(days=30) must exclude them.
function recent(offsetDaysAgo: number, hourUtc: number): Date {
  const d = new Date(NOW.getTime() - offsetDaysAgo * ONE_DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}
function recentIsoDay(offsetDaysAgo: number): string {
  // yyyy-mm-dd in UTC — fine for the from/to arg since finance/dates
  // interprets the range in the tenant tz.
  const d = new Date(NOW.getTime() - offsetDaysAgo * ONE_DAY);
  return d.toISOString().slice(0, 10);
}
const RECENT_FROM = recentIsoDay(21);
const RECENT_TO = recentIsoDay(0);

beforeAll(async () => {
  A = await seedPayrollTenant("w2-a");
  B = await seedPayrollTenant("w2-b");

  watchesCategory = await freshCategory(A, "watches", "ساعات");
  perfumesCategory = await freshCategory(A, "perfumes", "عطور");

  // ── products
  watchA = await seedProduct(A.tenantId, {
    categoryId: watchesCategory,
    branchId: A.branchId,
    name: "Guess Watch — hot seller",
    price: 2000,
    cost: 1500,
  });
  watchDead = await seedProduct(A.tenantId, {
    categoryId: watchesCategory,
    branchId: A.branchId,
    name: "Old Watch — not moving",
    price: 1800,
    cost: 1000,
  });
  watchNeverSold = await seedProduct(A.tenantId, {
    categoryId: watchesCategory,
    branchId: A.branchId,
    name: "Brand-new Watch — never sold",
    price: 2500,
    cost: 1800,
  });
  perfumeZeroCost = await seedProduct(A.tenantId, {
    categoryId: perfumesCategory,
    branchId: A.branchId,
    name: "Perfume with zero cost",
    price: 500,
    cost: 0,
  });
  perfumeNullCost = await seedProduct(A.tenantId, {
    categoryId: perfumesCategory,
    branchId: A.branchId,
    name: "Perfume with no cost at all",
    price: 500,
    cost: 60,
  });
  await setProductQuantity(A.tenantId, perfumeNullCost, 50, null);
  // Tune watchA quantities for predictable totals
  await setProductQuantity(A.tenantId, watchA, 10, 1500); // 15,000
  await setProductQuantity(A.tenantId, watchDead, 8, 1000); // 8,000
  await setProductQuantity(A.tenantId, watchNeverSold, 5, 1800); // 9,000
  await setProductQuantity(A.tenantId, perfumeZeroCost, 20, 0); // 0
  // perfumeNullCost already set to qty=50, cost=null → excluded from value
  // Tenant total inventory value (non-null, >0 cost) = 15000 + 8000 + 9000 = 32,000

  productInB = await seedProduct(B.tenantId, {
    categoryId: B.categoryId,
    branchId: B.branchId,
    name: "Tenant-B product",
    price: 500,
    cost: 250,
  });
  await setProductQuantity(B.tenantId, productInB, 100, 250);

  supplierHussein = await freshSupplier(A, "حسين المورد");
  supplierHusseinB = await freshSupplier(B, "حسين (B)");

  // ── sales (recent, relative to NOW, to pass dead-stock(days=30) + hour tests)
  // Fatma: first in window (new customer)
  await insertSale(A, {
    productId: watchA,
    totalPrice: 2000,
    saleDate: recent(20, 11), // 11:00 UTC → 13:00 Cairo (DST+2 in summer, +2 winter → may vary)
    customerPhone: CUSTOMER_FATMA,
    customerName: "فاطمة",
    invoiceId: "INV-A1",
  });
  // Ahmed: first in window too (we remove the April pre-anchor and classify
  // him differently in tests)
  await insertSale(A, {
    productId: watchA,
    totalPrice: 4000,
    saleDate: recent(18, 18), // 18:00 UTC → 20:00 Cairo
    customerPhone: CUSTOMER_AHMED,
    customerName: "أحمد",
    invoiceId: "INV-A2",
  });
  // Multi-line invoice for SARA (new customer) — one invoice, two lines
  await insertSale(A, {
    productId: watchA,
    totalPrice: 1000,
    saleDate: recent(10, 18),
    customerPhone: CUSTOMER_SARA,
    customerName: "سارة",
    invoiceId: "INV-A3",
  });
  await insertSale(A, {
    productId: watchA,
    totalPrice: 500,
    saleDate: recent(10, 18),
    customerPhone: CUSTOMER_SARA,
    customerName: "سارة",
    invoiceId: "INV-A3",
  });
  // Returned sale — must NOT count toward average basket
  await insertSale(A, {
    productId: watchA,
    totalPrice: 9999,
    saleDate: recent(15, 18),
    customerPhone: CUSTOMER_FATMA,
    customerName: "فاطمة",
    isReturned: true,
    invoiceId: "INV-R1",
  });
  // watchDead: last sale 2 years ago (very old). Inactive.
  await insertSale(A, {
    productId: watchDead,
    totalPrice: 1800,
    saleDate: new Date(NOW.getTime() - 400 * ONE_DAY),
    customerPhone: CUSTOMER_INACTIVE,
    customerName: "نشاط قديم",
    invoiceId: "INV-OLD1",
  });

  // Tenant-B leakage probe — these must NEVER show up in A's queries
  await insertSale(B, {
    productId: productInB,
    totalPrice: 7777,
    saleDate: recent(14, 10),
    customerPhone: CUSTOMER_FATMA, // same phone, different tenant
    customerName: "B-Fatma",
    invoiceId: "INV-B1",
  });

  // ── supplier price history for watchA
  await insertPOWithItems(A, supplierHussein, new Date("2026-03-01T10:00:00.000Z"), [
    { productId: watchA, productName: "Guess Watch", unitCost: 1000, quantity: 3 },
  ]);
  await insertPOWithItems(A, supplierHussein, new Date("2026-04-15T10:00:00.000Z"), [
    { productId: watchA, productName: "Guess Watch", unitCost: 1100, quantity: 5 },
  ]);
  await insertPOWithItems(A, supplierHussein, new Date("2026-06-10T10:00:00.000Z"), [
    { productId: watchA, productName: "Guess Watch", unitCost: 1250, quantity: 4 },
    // A second line for a different product — should NOT pollute the watchA-only aggregate
    { productId: watchDead, productName: "Old Watch", unitCost: 900, quantity: 2 },
  ]);
  // Tenant-B PO — must NEVER appear for A
  await insertPOWithItems(B, supplierHusseinB, new Date("2026-06-10T10:00:00.000Z"), [
    { productId: productInB, productName: "B Product", unitCost: 9999, quantity: 1 },
  ]);
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

/* ────────────────────── get_inventory_value ─────────────────────────── */

describe("get_inventory_value", () => {
  it("sums quantity × cost across all products, excluding null/zero-cost rows", async () => {
    const res = await executeTool(ownerCtx(A), "get_inventory_value", "{}");
    expect(res.ok).toBe(true);
    const data = (res as { data: { totalValue: number; excludedProductCount: number; productCount: number; totalQuantity: number } }).data;
    expect(data.totalValue).toBe(32_000);
    expect(data.productCount).toBe(5);
    // perfumeNullCost has qty=50, perfumeZeroCost has qty=20 — both excluded
    expect(data.excludedProductCount).toBe(2);
    expect(data.totalQuantity).toBe(10 + 8 + 5 + 20 + 50);
  });

  it("scopes to a single category when category_id passed", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_inventory_value",
      JSON.stringify({ category_id: watchesCategory }),
    );
    const data = (res as { data: { totalValue: number; filterCategoryId: string | null } }).data;
    expect(data.totalValue).toBe(32_000); // all three watches
    expect(data.filterCategoryId).toBe(watchesCategory);
  });

  it("category breakdown is sorted by totalValue DESC", async () => {
    const res = await executeTool(ownerCtx(A), "get_inventory_value", "{}");
    const data = (res as { data: { categoryBreakdown: Array<{ totalValue: number }> } }).data;
    const values = data.categoryBreakdown.map((c) => c.totalValue);
    const sorted = [...values].sort((a, b) => b - a);
    expect(values).toEqual(sorted);
  });

  it("cross-tenant: A cannot see B's inventory", async () => {
    const res = await executeTool(ownerCtx(B), "get_inventory_value", "{}");
    const data = (res as { data: { totalValue: number; productCount: number } }).data;
    expect(data.totalValue).toBe(100 * 250); // only B's product
    expect(data.productCount).toBe(1);
  });

  it("requires view_inventory permission", async () => {
    const res = await executeTool(unprivilegedCtx(A), "get_inventory_value", "{}");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });
});

/* ────────────────────── get_dead_stock_products ─────────────────────── */

describe("get_dead_stock_products", () => {
  it("returns inactive products (last sale older than days)", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_dead_stock_products",
      JSON.stringify({ days: 30 }),
    );
    expect(res.ok).toBe(true);
    const data = (res as { data: {
      rows: Array<{ productId: string; classification: string; daysSinceLastSale: number | null }>;
      neverSoldCount: number;
      inactiveCount: number;
    }}).data;
    const ids = data.rows.map((r) => r.productId);
    // watchDead last sold 2024-01 → inactive. watchNeverSold → never_sold.
    // perfumeNullCost + perfumeZeroCost have quantity > 0 and no sales → never_sold.
    expect(ids).toContain(watchDead);
    expect(ids).toContain(watchNeverSold);
    expect(ids).not.toContain(watchA); // recent sales exclude it
    expect(data.inactiveCount).toBeGreaterThanOrEqual(1);
    expect(data.neverSoldCount).toBeGreaterThanOrEqual(1);
  });

  it("excludes zero-stock by default (dead = capital tied up)", async () => {
    // Set watchNeverSold to qty=0 and re-check
    await setProductQuantity(A.tenantId, watchNeverSold, 0, 1800);
    const res = await executeTool(
      ownerCtx(A),
      "get_dead_stock_products",
      JSON.stringify({ days: 30 }),
    );
    const data = (res as { data: { rows: Array<{ productId: string }> } }).data;
    expect(data.rows.map((r) => r.productId)).not.toContain(watchNeverSold);
    // restore
    await setProductQuantity(A.tenantId, watchNeverSold, 5, 1800);
  });

  it("include_zero_stock=true brings zero-stock back in", async () => {
    await setProductQuantity(A.tenantId, watchNeverSold, 0, 1800);
    const res = await executeTool(
      ownerCtx(A),
      "get_dead_stock_products",
      JSON.stringify({ days: 30, include_zero_stock: true }),
    );
    const data = (res as { data: { rows: Array<{ productId: string }> } }).data;
    expect(data.rows.map((r) => r.productId)).toContain(watchNeverSold);
    await setProductQuantity(A.tenantId, watchNeverSold, 5, 1800);
  });

  it("classification distinguishes never_sold from inactive", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_dead_stock_products",
      JSON.stringify({ days: 30 }),
    );
    const data = (res as { data: { rows: Array<{ productId: string; classification: string; lastSaleDate: string | null }> } }).data;
    const dead = data.rows.find((r) => r.productId === watchDead);
    const never = data.rows.find((r) => r.productId === watchNeverSold);
    expect(dead?.classification).toBe("inactive");
    expect(dead?.lastSaleDate).not.toBeNull();
    expect(never?.classification).toBe("never_sold");
    expect(never?.lastSaleDate).toBeNull();
  });

  it("tiedUpValue sums quantity × cost for the dead rows", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_dead_stock_products",
      JSON.stringify({ days: 30, category_id: watchesCategory }),
    );
    const data = (res as { data: { tiedUpValue: number } }).data;
    // watchDead (8 × 1000) + watchNeverSold (5 × 1800) = 8000 + 9000 = 17000
    expect(data.tiedUpValue).toBe(17_000);
  });

  it("cross-tenant: B's dead stock not visible to A", async () => {
    const res = await executeTool(
      ownerCtx(B),
      "get_dead_stock_products",
      JSON.stringify({ days: 30 }),
    );
    const data = (res as { data: { rows: Array<{ productId: string }> } }).data;
    expect(data.rows.map((r) => r.productId)).not.toContain(watchDead);
  });

  it("requires view_inventory permission", async () => {
    const res = await executeTool(unprivilegedCtx(A), "get_dead_stock_products", "{}");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });
});

/* ────────────────────── get_zero_cost_products ──────────────────────── */

describe("get_zero_cost_products", () => {
  it("returns both null and zero when kind='any' (default)", async () => {
    const res = await executeTool(ownerCtx(A), "get_zero_cost_products", "{}");
    expect(res.ok).toBe(true);
    const data = (res as { data: { rows: Array<{ productId: string; kind: string }>; nullCostCount: number; zeroCostCount: number } }).data;
    const ids = data.rows.map((r) => r.productId);
    expect(ids).toContain(perfumeZeroCost);
    expect(ids).toContain(perfumeNullCost);
    expect(ids).not.toContain(watchA);
    expect(data.nullCostCount).toBe(1);
    expect(data.zeroCostCount).toBe(1);
  });

  it("kind='null_cost' returns only NULL rows", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_zero_cost_products",
      JSON.stringify({ kind: "null_cost" }),
    );
    const data = (res as { data: { rows: Array<{ kind: string; productId: string }> } }).data;
    expect(data.rows.every((r) => r.kind === "null_cost")).toBe(true);
    expect(data.rows.find((r) => r.productId === perfumeNullCost)).toBeDefined();
    expect(data.rows.find((r) => r.productId === perfumeZeroCost)).toBeUndefined();
  });

  it("kind='zero_cost' returns only 0 rows", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_zero_cost_products",
      JSON.stringify({ kind: "zero_cost" }),
    );
    const data = (res as { data: { rows: Array<{ kind: string; productId: string }> } }).data;
    expect(data.rows.every((r) => r.kind === "zero_cost")).toBe(true);
    expect(data.rows.find((r) => r.productId === perfumeZeroCost)).toBeDefined();
  });

  it("cross-tenant isolation", async () => {
    const res = await executeTool(ownerCtx(B), "get_zero_cost_products", "{}");
    const data = (res as { data: { rows: Array<{ productId: string }> } }).data;
    expect(data.rows.map((r) => r.productId)).not.toContain(perfumeZeroCost);
  });

  it("requires view_inventory permission", async () => {
    const res = await executeTool(unprivilegedCtx(A), "get_zero_cost_products", "{}");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });
});

/* ────────────────────── get_average_basket_size ─────────────────────── */

describe("get_average_basket_size", () => {
  it("divides non-returned revenue by distinct invoice count", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_average_basket_size",
      JSON.stringify({ from: RECENT_FROM, to: RECENT_TO }),
    );
    expect(res.ok).toBe(true);
    const data = (res as { data: { invoiceCount: number; totalRevenue: number; averageBasket: number } }).data;
    // 3 invoices in June (non-returned): INV-A1 (2000), INV-A2 (4000), INV-A3 (1500 across 2 lines)
    expect(data.invoiceCount).toBe(3);
    expect(data.totalRevenue).toBe(7500);
    expect(data.averageBasket).toBe(2500);
  });

  it("excludes returned invoices", async () => {
    // INV-R1 (9999, isReturned=true) sits at recent(15). Narrow window to the
    // single day around it so only the returned sale could match.
    const windowDay = recentIsoDay(15);
    const res = await executeTool(
      ownerCtx(A),
      "get_average_basket_size",
      JSON.stringify({ from: windowDay, to: windowDay }),
    );
    const data = (res as { data: { invoiceCount: number; totalRevenue: number } }).data;
    expect(data.invoiceCount).toBe(0);
    expect(data.totalRevenue).toBe(0);
  });

  it("zero invoices returns averageBasket=0 without dividing by zero", async () => {
    // Pick a window well before any fixture (200-year-ago is safe)
    const res = await executeTool(
      ownerCtx(A),
      "get_average_basket_size",
      JSON.stringify({ from: "1800-01-01", to: "1800-01-02" }),
    );
    const data = (res as { data: { invoiceCount: number; averageBasket: number } }).data;
    expect(data.invoiceCount).toBe(0);
    expect(data.averageBasket).toBe(0);
  });

  it("cross-tenant isolation", async () => {
    const res = await executeTool(
      ownerCtx(B),
      "get_average_basket_size",
      JSON.stringify({ from: RECENT_FROM, to: RECENT_TO }),
    );
    const data = (res as { data: { totalRevenue: number } }).data;
    expect(data.totalRevenue).toBe(7777); // only B's sale
  });

  it("requires view_sales permission", async () => {
    const res = await executeTool(unprivilegedCtx(A), "get_average_basket_size", "{}");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });
});

/* ────────────────────── get_sales_by_hour / dow ─────────────────────── */

describe("get_sales_by_hour", () => {
  it("returns 24 buckets in Africa/Cairo timezone", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_sales_by_hour",
      JSON.stringify({ from: RECENT_FROM, to: RECENT_TO }),
    );
    expect(res.ok).toBe(true);
    const data = (res as { data: { buckets: Array<{ hour: number; salesCount: number; revenue: number }>; timezone: string; peak: { hour: number } | null } }).data;
    expect(data.buckets).toHaveLength(24);
    expect(data.timezone).toContain("Cairo");
    // At least one hour should have revenue
    expect(data.buckets.some((b) => b.revenue > 0)).toBe(true);
    expect(data.peak).not.toBeNull();
  });

  it("sales are bucketed by Cairo wall-clock hour, not UTC", async () => {
    // The 20-day-ago sale was inserted at UTC hour 11. In Africa/Cairo it
    // should land 2 or 3 hours later depending on DST.
    const fatmaSaleDate = recent(20, 11);
    const dayStr = fatmaSaleDate.toISOString().slice(0, 10);
    const res = await executeTool(
      ownerCtx(A),
      "get_sales_by_hour",
      JSON.stringify({ from: dayStr, to: dayStr }),
    );
    const data = (res as { data: { buckets: Array<{ hour: number; salesCount: number }> } }).data;
    const expectedHourCairo = Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Cairo",
        hour: "2-digit",
        hourCycle: "h23",
      }).format(fatmaSaleDate),
    );
    // Exactly the Cairo hour should have at least one sale.
    expect(data.buckets.find((b) => b.hour === expectedHourCairo)?.salesCount).toBeGreaterThanOrEqual(1);
    // UTC hour 11 should NOT have the sale (unless Cairo happened to equal 11,
    // which it never does — Cairo is UTC+2/+3).
    expect(data.buckets[11].salesCount).toBe(0);
  });

  it("requires view_sales permission", async () => {
    const res = await executeTool(unprivilegedCtx(A), "get_sales_by_hour", "{}");
    expect(res.ok).toBe(false);
  });
});

describe("get_sales_by_day_of_week", () => {
  it("returns 7 buckets with labels", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_sales_by_day_of_week",
      JSON.stringify({ from: RECENT_FROM, to: RECENT_TO }),
    );
    expect(res.ok).toBe(true);
    const data = (res as { data: { buckets: Array<{ dow: number; label: { en: string; ar: string } }> } }).data;
    expect(data.buckets).toHaveLength(7);
    expect(data.buckets[0].label.en).toBe("Sunday");
    expect(data.buckets[6].label.ar).toBe("السبت");
  });

  it("cross-tenant isolation", async () => {
    const res = await executeTool(
      ownerCtx(B),
      "get_sales_by_day_of_week",
      JSON.stringify({ from: RECENT_FROM, to: RECENT_TO }),
    );
    const data = (res as { data: { buckets: Array<{ revenue: number }> } }).data;
    const total = data.buckets.reduce((s, b) => s + b.revenue, 0);
    expect(total).toBe(7777); // only B's sale, no leak from A
  });
});

/* ────────────────────── get_new_customers ───────────────────────────── */

describe("get_new_customers", () => {
  it("returns customers whose first-ever purchase is in the window", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_new_customers",
      JSON.stringify({ from: RECENT_FROM, to: RECENT_TO }),
    );
    expect(res.ok).toBe(true);
    const data = (res as { data: { count: number; customers: Array<{ customerPhone: string }> } }).data;
    const phones = data.customers.map((c) => c.customerPhone);
    // Fatma, Ahmed, Sara all have their first ever sale inside the window
    expect(phones).toContain(CUSTOMER_FATMA);
    expect(phones).toContain(CUSTOMER_AHMED);
    expect(phones).toContain(CUSTOMER_SARA);
    // CUSTOMER_INACTIVE's first+only sale is 400d ago → NOT new in recent window
    expect(phones).not.toContain(CUSTOMER_INACTIVE);
    expect(data.count).toBe(3);
  });

  it("excludes customers whose first purchase pre-dates the window", async () => {
    // Narrow the window to a day where none of the recent fixtures land but
    // CUSTOMER_INACTIVE's 400-day-old sale does.
    const inactiveSaleDate = new Date(NOW.getTime() - 400 * ONE_DAY);
    const from = new Date(inactiveSaleDate.getTime() - ONE_DAY).toISOString().slice(0, 10);
    const to = new Date(inactiveSaleDate.getTime() + ONE_DAY).toISOString().slice(0, 10);
    const res = await executeTool(
      ownerCtx(A),
      "get_new_customers",
      JSON.stringify({ from, to }),
    );
    const data = (res as { data: { customers: Array<{ customerPhone: string }> } }).data;
    expect(data.customers.map((c) => c.customerPhone)).toContain(CUSTOMER_INACTIVE);
    // Recent-window customers must NOT appear in this old window
    expect(data.customers.map((c) => c.customerPhone)).not.toContain(CUSTOMER_FATMA);
  });

  it("RANGE_REQUIRED for period='all'", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_new_customers",
      JSON.stringify({ period: "all" }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("RANGE_REQUIRED");
  });

  it("cross-tenant: A's Fatma phone doesn't surface B's identical phone", async () => {
    const res = await executeTool(
      ownerCtx(B),
      "get_new_customers",
      JSON.stringify({ from: RECENT_FROM, to: RECENT_TO }),
    );
    const data = (res as { data: { count: number; customers: Array<{ customerName: string | null }> } }).data;
    expect(data.count).toBe(1);
    expect(data.customers[0].customerName).toBe("B-Fatma");
  });

  it("requires view_customers permission", async () => {
    const res = await executeTool(unprivilegedCtx(A), "get_new_customers", "{}");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });
});

/* ────────────────────── get_inactive_customers ──────────────────────── */

describe("get_inactive_customers", () => {
  it("returns customers whose last purchase is older than threshold", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_inactive_customers",
      JSON.stringify({ days: 365 }),
    );
    expect(res.ok).toBe(true);
    const data = (res as { data: { count: number; customers: Array<{ customerPhone: string; daysSinceLastPurchase: number }> } }).data;
    // CUSTOMER_INACTIVE's only sale is 2024-01 → very old → should appear with
    // large daysSinceLastPurchase
    const inactive = data.customers.find((c) => c.customerPhone === CUSTOMER_INACTIVE);
    expect(inactive).toBeDefined();
    expect(inactive!.daysSinceLastPurchase).toBeGreaterThan(365);
    // Fatma / Sara / Ahmed all have recent 2026 sales → not inactive at 365d
    expect(data.customers.map((c) => c.customerPhone)).not.toContain(CUSTOMER_FATMA);
    expect(data.customers.map((c) => c.customerPhone)).not.toContain(CUSTOMER_SARA);
  });

  it("threshold too tight → empty", async () => {
    // Very long threshold so no one qualifies (older than 100 years)
    const res = await executeTool(
      ownerCtx(A),
      "get_inactive_customers",
      JSON.stringify({ days: 36_500 }),
    );
    const data = (res as { data: { count: number } }).data;
    expect(data.count).toBe(0);
  });

  it("cross-tenant isolation", async () => {
    const res = await executeTool(
      ownerCtx(B),
      "get_inactive_customers",
      JSON.stringify({ days: 1 }),
    );
    const data = (res as { data: { customers: Array<{ customerPhone: string }> } }).data;
    // B has only one customer with a 2026-06 sale → not inactive at 1-day
    // threshold (as of suite runtime), and definitely isolated from A.
    expect(data.customers.find((c) => c.customerPhone === CUSTOMER_INACTIVE)).toBeUndefined();
  });

  it("requires view_customers permission", async () => {
    const res = await executeTool(unprivilegedCtx(A), "get_inactive_customers", "{}");
    expect(res.ok).toBe(false);
  });
});

/* ────────────────────── get_supplier_price_history ──────────────────── */

describe("get_supplier_price_history", () => {
  it("returns timeline + aggregate when scoped to one product", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_supplier_price_history",
      JSON.stringify({ supplier_id: supplierHussein, product_id: watchA }),
    );
    expect(res.ok).toBe(true);
    const data = (res as { data: {
      aggregate: {
        firstCost: number;
        latestCost: number;
        costDelta: number;
        costChangePct: number;
        observationCount: number;
      } | null;
      rows: Array<{ productId: string | null; unitCost: number }>;
    }}).data;
    expect(data.aggregate).not.toBeNull();
    expect(data.aggregate!.firstCost).toBe(1000);
    expect(data.aggregate!.latestCost).toBe(1250);
    expect(data.aggregate!.costDelta).toBe(250);
    expect(data.aggregate!.costChangePct).toBe(25);
    expect(data.aggregate!.observationCount).toBe(3);
    // Rows are newest-first
    expect(data.rows[0].unitCost).toBe(1250);
    // All rows scoped to watchA
    expect(data.rows.every((r) => r.productId === watchA)).toBe(true);
  });

  it("without product_id, aggregate is null and rows span products", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_supplier_price_history",
      JSON.stringify({ supplier_id: supplierHussein }),
    );
    const data = (res as { data: { aggregate: unknown; rows: Array<{ productId: string | null }> } }).data;
    expect(data.aggregate).toBeNull();
    const distinctProducts = new Set(data.rows.map((r) => r.productId));
    expect(distinctProducts.size).toBeGreaterThan(1);
  });

  it("cross-tenant: B's price history isolated from A", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_supplier_price_history",
      JSON.stringify({ supplier_id: supplierHusseinB }),
    );
    const data = (res as { data: { rows: Array<{ unitCost: number }> } }).data;
    // A asking for B's supplier → zero rows (tenant_id filter)
    expect(data.rows).toHaveLength(0);
  });

  it("MISSING_SUPPLIER_ID when supplier_id is empty", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_supplier_price_history",
      JSON.stringify({ supplier_id: "" }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("MISSING_SUPPLIER_ID");
  });

  it("requires view_purchases permission", async () => {
    const res = await executeTool(
      unprivilegedCtx(A),
      "get_supplier_price_history",
      JSON.stringify({ supplier_id: supplierHussein }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });
});
