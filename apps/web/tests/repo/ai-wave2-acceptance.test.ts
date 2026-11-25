// Phase B P1 Wave 2 — live Gemini acceptance.
//
// Fires REAL Gemini calls through runAgent() to verify tool selection for the
// nine new Wave 2 analytics tools. Enable with:
//
//   PHASE_B_LIVE=1 npx vitest run tests/repo/ai-wave2-acceptance.test.ts
//
// Assertions are STRUCTURAL (tool names, debug.toolsCalled) — Gemini's prose
// is non-deterministic.

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
import { runAgent } from "@/lib/ai/agent";
import type { AgentContext } from "@/lib/ai/context";
import type { AiBlock } from "@/lib/ai/responses";
import {
  seedPayrollTenant,
  seedProduct,
  type PayrollTenantSeed,
} from "./payroll-fixtures";

const LIVE = process.env.PHASE_B_LIVE === "1";
const d = LIVE ? describe : describe.skip;

const ONE_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
function daysAgo(n: number, hourUtc = 12): Date {
  const x = new Date(NOW.getTime() - n * ONE_DAY);
  x.setUTCHours(hourUtc, 0, 0, 0);
  return x;
}

async function freshSupplier(seedS: PayrollTenantSeed, name: string): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${seedS.tenantId}, true)`);
    const [s] = await tx
      .insert(suppliers)
      .values({
        tenantId: seedS.tenantId,
        branchId: seedS.branchId,
        name,
        phone: `+2010${Math.random().toString().slice(2, 10)}`,
      })
      .returning({ id: suppliers.id });
    return s.id;
  });
}

async function insertSale(seedS: PayrollTenantSeed, args: {
  productId: string;
  totalPrice: number;
  saleDate: Date;
  customerPhone?: string;
  customerName?: string;
  isReturned?: boolean;
  invoiceId?: string;
}): Promise<void> {
  await withTenant(seedS.tenantId, async (tx) => {
    await tx.insert(sales).values({
      tenantId: seedS.tenantId,
      branchId: seedS.branchId,
      invoiceId: args.invoiceId ?? null,
      productId: args.productId,
      productName: "test",
      categoryId: seedS.categoryId,
      quantitySold: 1,
      pricePerUnit: String(args.totalPrice),
      subtotal: String(args.totalPrice),
      totalPrice: String(args.totalPrice),
      saleDate: args.saleDate,
      isReturned: args.isReturned ?? false,
      paymentMethod: "cash",
      isPaid: true,
      amountPaid: String(args.totalPrice),
      customerPhone: args.customerPhone ?? null,
      customerName: args.customerName ?? null,
    });
  });
}

async function insertPOWithItems(
  seedS: PayrollTenantSeed,
  supplierId: string,
  orderDate: Date,
  items: Array<{ productId: string; productName: string; unitCost: number; quantity: number }>,
): Promise<void> {
  const total = items.reduce((s, i) => s + i.unitCost * i.quantity, 0);
  await withTenant(seedS.tenantId, async (tx) => {
    const [po] = await tx
      .insert(purchaseOrders)
      .values({
        tenantId: seedS.tenantId,
        branchId: seedS.branchId,
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
        tenantId: seedS.tenantId,
        purchaseOrderId: po.id,
        productId: it.productId,
        productName: it.productName,
        quantity: it.quantity,
        unitCost: String(it.unitCost),
        lineTotal: String(it.unitCost * it.quantity),
      });
    }
  });
}

function ownerCtx(seedS: PayrollTenantSeed, locale: "ar" | "en" = "ar"): AgentContext {
  return {
    tenantId: seedS.tenantId,
    userId: seedS.ownerId,
    branchId: null,
    role: "owner",
    permissions: [
      "view_inventory",
      "view_sales",
      "view_customers",
      "view_suppliers",
      "view_purchases",
      "view_insights",
      "view_financials",
      "view_profit",
      "manage_purchases",
    ],
    locale,
  } as AgentContext;
}

type ConvoTurn = { role: "user" | "assistant"; content: string };

async function ask(
  seedS: PayrollTenantSeed,
  history: ConvoTurn[],
  locale: "ar" | "en" = "ar",
): Promise<{ blocks: AiBlock[]; toolsCalled: string[]; text: string }> {
  const { response, debug } = await runAgent({
    ctx: ownerCtx(seedS, locale),
    messages: history,
    requestId: `w2-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  });
  const text = response.blocks
    .filter((b): b is Extract<AiBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
  return { blocks: response.blocks, toolsCalled: debug.toolsCalled, text };
}

let seed: PayrollTenantSeed;
let watchesCategoryId: string;
let perfumesCategoryId: string;
let watchA: string;
let watchDead: string;
let watchNeverSold: string;
let perfumeZeroCost: string;
let supplierHussein: string;
const FATMA = "+201111111111";
const AHMED = "+201222222222";
const SARA = "+201333333333";
const INACTIVE = "+201444444444";

beforeAll(async () => {
  if (!LIVE) return;
  seed = await seedPayrollTenant("w2-live");

  // Replace the default seed category with named ones for the Agent to see.
  const [watches] = await withTenant(seed.tenantId, (tx) =>
    tx.insert(categories).values({
      tenantId: seed.tenantId,
      branchId: seed.branchId,
      key: "watches",
      label: "ساعات",
      position: 1,
    }).returning({ id: categories.id }),
  );
  const [perfumes] = await withTenant(seed.tenantId, (tx) =>
    tx.insert(categories).values({
      tenantId: seed.tenantId,
      branchId: seed.branchId,
      key: "perfumes",
      label: "عطور",
      position: 2,
    }).returning({ id: categories.id }),
  );
  watchesCategoryId = watches.id;
  perfumesCategoryId = perfumes.id;

  watchA = await seedProduct(seed.tenantId, {
    categoryId: watchesCategoryId,
    branchId: seed.branchId,
    name: "Guess Platinum",
    price: 2200,
    cost: 1500,
  });
  watchDead = await seedProduct(seed.tenantId, {
    categoryId: watchesCategoryId,
    branchId: seed.branchId,
    name: "Fossil Classic",
    price: 1800,
    cost: 1000,
  });
  watchNeverSold = await seedProduct(seed.tenantId, {
    categoryId: watchesCategoryId,
    branchId: seed.branchId,
    name: "Rolex Oyster Replica",
    price: 4500,
    cost: 3000,
  });
  perfumeZeroCost = await seedProduct(seed.tenantId, {
    categoryId: perfumesCategoryId,
    branchId: seed.branchId,
    name: "Elie Saab Mystery",
    price: 900,
    cost: 0,
  });
  void perfumeZeroCost;

  // Update quantities to realistic values
  await withTenant(seed.tenantId, async (tx) => {
    await tx.update(products).set({ quantity: 15, costPrice: "1500" }).where(and(eq(products.tenantId, seed.tenantId), eq(products.id, watchA)));
    await tx.update(products).set({ quantity: 10, costPrice: "1000" }).where(and(eq(products.tenantId, seed.tenantId), eq(products.id, watchDead)));
    await tx.update(products).set({ quantity: 3, costPrice: "3000" }).where(and(eq(products.tenantId, seed.tenantId), eq(products.id, watchNeverSold)));
    await tx.update(products).set({ quantity: 20, costPrice: "0" }).where(and(eq(products.tenantId, seed.tenantId), eq(products.id, perfumeZeroCost)));
  });

  supplierHussein = await freshSupplier(seed, "حسين");

  // Recent sales (last 21 days)
  await insertSale(seed, { productId: watchA, totalPrice: 2200, saleDate: daysAgo(18, 11), customerPhone: FATMA, customerName: "فاطمة", invoiceId: "INV-1" });
  await insertSale(seed, { productId: watchA, totalPrice: 2200, saleDate: daysAgo(14, 18), customerPhone: AHMED, customerName: "أحمد", invoiceId: "INV-2" });
  await insertSale(seed, { productId: watchA, totalPrice: 2200, saleDate: daysAgo(5, 10), customerPhone: SARA, customerName: "سارة", invoiceId: "INV-3" });
  // Old inactive customer
  await insertSale(seed, { productId: watchDead, totalPrice: 1800, saleDate: new Date(NOW.getTime() - 200 * ONE_DAY), customerPhone: INACTIVE, customerName: "قديم", invoiceId: "INV-OLD" });

  // Supplier cost trend for watchA
  await insertPOWithItems(seed, supplierHussein, new Date(NOW.getTime() - 180 * ONE_DAY), [
    { productId: watchA, productName: "Guess Platinum", unitCost: 1200, quantity: 5 },
  ]);
  await insertPOWithItems(seed, supplierHussein, new Date(NOW.getTime() - 90 * ONE_DAY), [
    { productId: watchA, productName: "Guess Platinum", unitCost: 1350, quantity: 5 },
  ]);
  await insertPOWithItems(seed, supplierHussein, new Date(NOW.getTime() - 20 * ONE_DAY), [
    { productId: watchA, productName: "Guess Platinum", unitCost: 1500, quantity: 5 },
  ]);
});

afterAll(async () => {
  if (!LIVE) return;
  await seed.cleanup();
});

/* ──────────────── Scenarios ───────────────────── */

d("W2 live — Inventory intelligence", () => {
  it("S1. 'قيمة المخزون كام؟' → get_inventory_value", async () => {
    const r = await ask(seed, [{ role: "user", content: "قيمة المخزون عندي كام؟" }]);
    expect(r.toolsCalled).toContain("get_inventory_value");
    // must NOT confuse with COGS / sales
    expect(r.toolsCalled).not.toContain("get_pnl");
    expect(r.toolsCalled).not.toContain("get_sales_overview");
  }, 60_000);

  it("S2. 'المنتجات اللي نايمة 30 يوم' → get_dead_stock_products", async () => {
    const r = await ask(seed, [{ role: "user", content: "إيه المنتجات اللي نايمة بقالها 30 يوم؟" }]);
    expect(r.toolsCalled).toContain("get_dead_stock_products");
    expect(r.toolsCalled).not.toContain("get_zero_cost_products");
  }, 60_000);

  it("S3. 'منتجات تكلفتها صفر' → get_zero_cost_products", async () => {
    const r = await ask(seed, [{ role: "user", content: "عندي منتجات تكلفتها صفر؟" }]);
    expect(r.toolsCalled).toContain("get_zero_cost_products");
    expect(r.toolsCalled).not.toContain("get_dead_stock_products");
  }, 60_000);
});

d("W2 live — Sales intelligence", () => {
  it("S4. 'متوسط الفاتورة الشهر ده' → get_average_basket_size", async () => {
    const r = await ask(seed, [{ role: "user", content: "متوسط الفاتورة الشهر ده كام؟" }]);
    expect(r.toolsCalled).toContain("get_average_basket_size");
  }, 60_000);

  it("S5. 'أكتر ساعة ببيع فيها' → get_sales_by_hour", async () => {
    const r = await ask(seed, [{ role: "user", content: "أكتر ساعة ببيع فيها إمتى؟" }]);
    expect(r.toolsCalled).toContain("get_sales_by_hour");
  }, 60_000);

  it("S6. 'أنهي يوم أحسن' → get_sales_by_day_of_week", async () => {
    const r = await ask(seed, [{ role: "user", content: "أنهي يوم في الأسبوع أحسن في المبيعات؟" }]);
    expect(r.toolsCalled).toContain("get_sales_by_day_of_week");
  }, 60_000);
});

d("W2 live — Customer intelligence", () => {
  it("S7. 'عملاء جدد الشهر ده' → get_new_customers", async () => {
    const r = await ask(seed, [{ role: "user", content: "جابلي كام عميل جديد الشهر ده؟" }]);
    expect(r.toolsCalled).toContain("get_new_customers");
    expect(r.toolsCalled).not.toContain("get_top_customers");
  }, 60_000);

  it("S8. 'مين مبقالوش شراء 60 يوم' → get_inactive_customers", async () => {
    const r = await ask(seed, [{ role: "user", content: "مين العملاء اللي مبقالهمش شراء 60 يوم؟" }]);
    expect(r.toolsCalled).toContain("get_inactive_customers");
    // Must NEVER label as "churned" — recommendations only on request
    expect(r.text.toLowerCase()).not.toContain("churned");
  }, 60_000);
});

d("W2 live — Supplier intelligence", () => {
  it("S9. supplier cost timeline for a named product → get_supplier_price_history", async () => {
    const r = await ask(seed, [
      { role: "user", content: "حسين كان بيبيعلي ساعة Guess Platinum بكام؟" },
    ]);
    expect(r.toolsCalled).toContain("get_supplier_price_history");
  }, 60_000);

  it("S10. 'حسين غلى سعر Guess Platinum؟' → get_supplier_price_history, aggregates the change", async () => {
    const r = await ask(seed, [
      { role: "user", content: "سعر Guess Platinum من حسين زاد؟" },
    ]);
    expect(r.toolsCalled).toContain("get_supplier_price_history");
  }, 60_000);
});

d("W2 live — Mixed language + ambiguity + security", () => {
  it("S11. English inventory value question → get_inventory_value", async () => {
    const r = await ask(
      seed,
      [{ role: "user", content: "How much is my current inventory worth at cost?" }],
      "en",
    );
    expect(r.toolsCalled).toContain("get_inventory_value");
  }, 60_000);

  it("S12. Mixed AR/EN dead stock → get_dead_stock_products", async () => {
    const r = await ask(seed, [
      { role: "user", content: "show me the dead stock اللي بقاله شهر ماتباعش" },
    ]);
    expect(r.toolsCalled).toContain("get_dead_stock_products");
  }, 60_000);

  it("S13. Natural Arabic date 'الأسبوع اللي فات' → average basket scoped to window", async () => {
    const r = await ask(seed, [
      { role: "user", content: "متوسط الفاتورة الأسبوع اللي فات؟" },
    ]);
    expect(r.toolsCalled).toContain("get_average_basket_size");
  }, 60_000);

  it("S14. Ambiguous supplier → should ask, not invent", async () => {
    const r = await ask(seed, [
      { role: "user", content: "حسين غلي عليا ساعة لسه مش فاكر اسمها" },
    ]);
    // Either asks for the product (no tool call OR search_products) OR calls
    // get_supplier_price_history WITHOUT a product_id and reports the general
    // timeline. Both are acceptable — the model must NOT fabricate.
    // Assertion: did not invent the aggregate as a "rose/fell" claim.
    expect(r.text.toLowerCase()).not.toMatch(/increased by \d+%/);
  }, 60_000);
});

d("W2 live — Negative reasoning (wrong-tool traps)", () => {
  it("S15. 'قيمة المخزون' must NOT call get_pnl (inventory value ≠ COGS)", async () => {
    const r = await ask(seed, [{ role: "user", content: "قيمة البضاعة اللي عندي كام؟" }]);
    expect(r.toolsCalled).toContain("get_inventory_value");
    expect(r.toolsCalled).not.toContain("get_pnl");
    expect(r.toolsCalled).not.toContain("get_financials_overview");
  }, 60_000);

  it("S16. 'نايم' must NOT call get_zero_cost_products", async () => {
    const r = await ask(seed, [{ role: "user", content: "البضاعة اللي نايمة عندي" }]);
    expect(r.toolsCalled).toContain("get_dead_stock_products");
    expect(r.toolsCalled).not.toContain("get_zero_cost_products");
  }, 60_000);

  it("S17. supplier price question must NOT use current product cost", async () => {
    const r = await ask(seed, [
      { role: "user", content: "حسين كان بيبيعلي Guess Platinum بكام الشهر اللي فات؟" },
    ]);
    expect(r.toolsCalled).toContain("get_supplier_price_history");
    // get_product is only OK as a resolve step; MUST also fetch price history
  }, 60_000);
});
