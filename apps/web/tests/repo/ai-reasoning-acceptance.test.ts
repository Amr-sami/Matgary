// Phase B Final — live Gemini acceptance for the reasoning layer.
//
// Enable with: PHASE_B_LIVE=1 npx vitest run tests/repo/ai-reasoning-acceptance.test.ts
//
// Fires REAL Gemini calls through runAgent() to verify tool selection, event
// disambiguation, multi-intent decomposition, and corrections. Assertions
// are STRUCTURAL (debug.toolsCalled, counterparty tool invocation).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  categories,
  products,
  purchaseOrders,
  sales,
  suppliers,
  tenantMembers,
  users,
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

function ownerCtx(seed: PayrollTenantSeed, locale: "ar" | "en" = "ar"): AgentContext {
  return {
    tenantId: seed.tenantId,
    userId: seed.ownerId,
    branchId: null,
    role: "owner",
    permissions: [
      "manage_purchases",
      "view_suppliers",
      "view_purchases",
      "view_inventory",
      "view_sales",
      "view_customers",
      "view_insights",
      "view_financials",
      "view_profit",
      "view_dashboard",
      "manage_inventory",
      "manage_expenses",
    ],
    locale,
  } as AgentContext;
}

type ConvoTurn = { role: "user" | "assistant"; content: string };

async function ask(
  seed: PayrollTenantSeed,
  history: ConvoTurn[],
  locale: "ar" | "en" = "ar",
): Promise<{ blocks: AiBlock[]; toolsCalled: string[]; text: string }> {
  const { response, debug } = await runAgent({
    ctx: ownerCtx(seed, locale),
    messages: history,
    requestId: `rz-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  });
  const text = response.blocks
    .filter((b): b is Extract<AiBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
  return { blocks: response.blocks, toolsCalled: debug.toolsCalled, text };
}

async function freshSupplier(seed: PayrollTenantSeed, name: string, balance = 0): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${seed.tenantId}, true)`);
    const [s] = await tx
      .insert(suppliers)
      .values({
        tenantId: seed.tenantId,
        branchId: seed.branchId,
        name,
        phone: `+2010${Math.random().toString().slice(2, 10)}`,
        balance: String(balance),
      })
      .returning({ id: suppliers.id });
    return s.id;
  });
}

async function freshEmployee(seed: PayrollTenantSeed, name: string): Promise<string> {
  return db.transaction(async (tx) => {
    const email = `emp-${Math.random().toString(36).slice(2, 10)}@test.local`;
    const [u] = await tx
      .insert(users)
      .values({ email, name, passwordHash: "x" })
      .returning({ id: users.id });
    await tx.insert(tenantMembers).values({
      tenantId: seed.tenantId,
      userId: u.id,
      role: "staff",
      displayName: name,
    });
    return u.id;
  });
}

let seed: PayrollTenantSeed;
let watchesCategoryId: string;
let supplierHussein: string;
let onlySupplier: string;
let productA: string;
let productDead: string;

beforeAll(async () => {
  if (!LIVE) return;
  seed = await seedPayrollTenant("reason-live");

  const [watches] = await withTenant(seed.tenantId, (tx) =>
    tx
      .insert(categories)
      .values({
        tenantId: seed.tenantId,
        branchId: seed.branchId,
        key: "watches",
        label: "ساعات",
        position: 1,
      })
      .returning({ id: categories.id }),
  );
  watchesCategoryId = watches.id;

  // Hussein as BOTH supplier AND employee — the key ambiguity fixture.
  supplierHussein = await freshSupplier(seed, "حسين", 5_000);
  await freshEmployee(seed, "حسين");
  // Supplier-only Mahmoud (for the "pay Mahmoud" supplier-payment flow)
  onlySupplier = await freshSupplier(seed, "محمود المورد", 12_000);

  productA = await seedProduct(seed.tenantId, {
    categoryId: watchesCategoryId,
    branchId: seed.branchId,
    name: "Naviforce MF0612",
    price: 2200,
    cost: 1500,
  });
  productDead = await seedProduct(seed.tenantId, {
    categoryId: watchesCategoryId,
    branchId: seed.branchId,
    name: "Old Fossil",
    price: 1800,
    cost: 1000,
  });

  await withTenant(seed.tenantId, async (tx) => {
    await tx
      .update(products)
      .set({ quantity: 2, lowStockThreshold: 5, costPrice: "1500" })
      .where(and(eq(products.tenantId, seed.tenantId), eq(products.id, productA)));
    await tx
      .update(products)
      .set({ quantity: 10, costPrice: "1000" })
      .where(and(eq(products.tenantId, seed.tenantId), eq(products.id, productDead)));
  });

  // Received PO for Mahmoud so there's an outstanding PO to reference.
  await withTenant(seed.tenantId, async (tx) => {
    await tx.insert(purchaseOrders).values({
      tenantId: seed.tenantId,
      branchId: seed.branchId,
      supplierId: onlySupplier,
      status: "received",
      total: "12000",
      paidAmount: "0",
      orderDate: new Date(NOW.getTime() - 5 * ONE_DAY),
      receivedDate: new Date(NOW.getTime() - 5 * ONE_DAY),
    });
    // Recent sale for productA + old sale for productDead (feeds get_shop_pulse dead_stock signal)
    await tx.insert(sales).values({
      tenantId: seed.tenantId,
      branchId: seed.branchId,
      productId: productA,
      productName: "Naviforce MF0612",
      categoryId: watchesCategoryId,
      quantitySold: 1,
      pricePerUnit: "2200",
      subtotal: "2200",
      totalPrice: "2200",
      saleDate: new Date(NOW.getTime() - 2 * ONE_DAY),
      customerPhone: "+201000000001",
      paymentMethod: "cash",
      isPaid: true,
      amountPaid: "2200",
      invoiceId: "INV-R1",
      isReturned: false,
    });
    await tx.insert(sales).values({
      tenantId: seed.tenantId,
      branchId: seed.branchId,
      productId: productDead,
      productName: "Old Fossil",
      categoryId: watchesCategoryId,
      quantitySold: 1,
      pricePerUnit: "1800",
      subtotal: "1800",
      totalPrice: "1800",
      saleDate: new Date(NOW.getTime() - 200 * ONE_DAY),
      customerPhone: "+201000000002",
      paymentMethod: "cash",
      isPaid: true,
      amountPaid: "1800",
      invoiceId: "INV-OLD",
      isReturned: false,
    });
  });
});

afterAll(async () => {
  if (!LIVE) return;
  await seed.cleanup();
});

/* ──────────── Event disambiguation ─────────────── */

d("EV live — payment counterparty disambiguation", () => {
  it("EV1. 'دفعت لحسين 3000' when Hussein is BOTH supplier + employee → resolves + asks or picks ambiguous classification", async () => {
    const r = await ask(seed, [{ role: "user", content: "دفعت لحسين 3000" }]);
    expect(r.toolsCalled).toContain("resolve_payment_counterparty");
    // Model should NOT silently execute a supplier payment preview.
    expect(r.toolsCalled).not.toContain("preview_record_purchase_payment");
  }, 60_000);

  it("EV2. 'دفعت لمحمود 3000' (supplier-only name) → counterparty resolver + supplier payment flow", async () => {
    const r = await ask(seed, [{ role: "user", content: "دفعت لمحمود 3000" }]);
    expect(r.toolsCalled).toContain("resolve_payment_counterparty");
    // Follow-up should be list_unpaid_purchase_orders OR preview_record_purchase_payment.
    const continued =
      r.toolsCalled.includes("list_unpaid_purchase_orders") ||
      r.toolsCalled.includes("preview_record_purchase_payment");
    expect(continued).toBe(true);
    // MUST NOT reach for expense creation
    expect(r.toolsCalled).not.toContain("preview_create_expense");
  }, 90_000);
});

/* ──────────── Inventory adjust vs purchase ───────── */

d("EV live — inventory adjust vs purchase", () => {
  it("EV3. 'جردت ولقيت زيادة 3 في Naviforce' → preview_update_product_quantity (NOT create_purchase)", async () => {
    const r = await ask(seed, [
      {
        role: "user",
        content: "جردت المحل ولقيت زيادة 3 قطع من ساعة Naviforce، صحح الكمية.",
      },
    ]);
    // Must resolve product first + call the quantity adjust staged write
    expect(r.toolsCalled).toContain("search_products");
    expect(r.toolsCalled).toContain("preview_update_product_quantity");
    // Must NOT treat it as a purchase event
    expect(r.toolsCalled).not.toContain("preview_create_purchase");
  }, 90_000);
});

/* ──────────── Multi-intent purchase ─────────────── */

d("EV live — multi-intent purchase in one sentence", () => {
  it("EV4. 'جبت 10 ساعات من محمود بـ 500 الواحدة، دفعتله 3000' → one purchase preview with paidNow=3000", async () => {
    const r = await ask(seed, [
      {
        role: "user",
        content:
          "جبت 10 ساعات Naviforce من محمود المورد، سعر الواحدة 500، ودفعتله 3000 والباقي عليا.",
      },
    ]);
    // Must land on preview_create_purchase (not expense, not record_payment)
    expect(r.toolsCalled).toContain("preview_create_purchase");
    expect(r.toolsCalled).not.toContain("preview_create_expense");
    expect(r.toolsCalled).not.toContain("preview_record_purchase_payment");
  }, 120_000);
});

/* ──────────── Shop pulse ─────────────── */

d("EV live — shop pulse / attention summary", () => {
  it("EV5. 'في حاجة محتاجة آخد بالي منها؟' → calls get_shop_pulse", async () => {
    const r = await ask(seed, [
      { role: "user", content: "في حاجة محتاجة آخد بالي منها دلوقتي؟" },
    ]);
    expect(r.toolsCalled).toContain("get_shop_pulse");
    // Reply must be grounded — look for at least one of the seeded signals
    // (low stock, dead stock, supplier payable) by keyword, in Arabic.
    const grounded =
      /منخفض|نايم|مش بيتحرك|مورد|ديون|تحت حد التنبيه/i.test(r.text);
    expect(grounded).toBe(true);
  }, 90_000);

  it("EV6. 'إيه الأهم عندي دلوقتي؟' → same pulse path, no duplicate pulse call", async () => {
    const r = await ask(seed, [
      { role: "user", content: "إيه الأهم عندي دلوقتي أراجعه؟" },
    ]);
    expect(r.toolsCalled).toContain("get_shop_pulse");
    const pulseCalls = r.toolsCalled.filter((t) => t === "get_shop_pulse").length;
    expect(pulseCalls).toBe(1);
  }, 90_000);
});

/* ──────────── Sales = POS only ─────────────── */

d("EV live — sales guardrail", () => {
  it("EV7. 'بعت 5 ساعات النهارده' → must NOT call preview_create_purchase / preview_create_expense", async () => {
    const r = await ask(seed, [
      { role: "user", content: "بعت 5 ساعات Naviforce النهارده." },
    ]);
    expect(r.toolsCalled).not.toContain("preview_create_purchase");
    expect(r.toolsCalled).not.toContain("preview_create_expense");
    expect(r.toolsCalled).not.toContain("preview_update_product_quantity");
    // The reply should direct the user toward POS (clarification, not a silent mutation).
    expect(r.text.toLowerCase()).not.toMatch(/تم تسجيل البيع|sale recorded/);
  }, 60_000);
});

/* ──────────── English mirror ─────────────── */

d("EV live — English parity", () => {
  it("EV8. 'paid Hussein 3000' (ambiguous name) → resolve_payment_counterparty", async () => {
    const r = await ask(
      seed,
      [{ role: "user", content: "I paid Hussein 3000 yesterday." }],
      "en",
    );
    expect(r.toolsCalled).toContain("resolve_payment_counterparty");
    expect(r.toolsCalled).not.toContain("preview_record_purchase_payment");
  }, 60_000);
});
