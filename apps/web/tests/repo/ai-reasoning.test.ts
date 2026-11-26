// Phase B final reasoning layer — resolve_payment_counterparty + get_shop_pulse.
// Real Postgres, two tenants, every path.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  products,
  purchaseOrders,
  sales,
  suppliers,
  tenantMembers,
  users,
} from "@/lib/db/schema";
import { executeTool } from "@/lib/ai/tools";
import type { AgentContext } from "@/lib/ai/context";
import {
  seedPayrollTenant,
  seedProduct,
  type PayrollTenantSeed,
} from "./payroll-fixtures";

const ONE_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();

function ctxOf(
  seed: PayrollTenantSeed,
  role: "owner" | "staff",
  perms: string[],
): AgentContext {
  return {
    tenantId: seed.tenantId,
    userId: seed.ownerId,
    branchId: null,
    role,
    permissions: perms,
    locale: "en",
  } as AgentContext;
}

function ownerCtx(seed: PayrollTenantSeed): AgentContext {
  return ctxOf(seed, "owner", [
    "view_inventory",
    "view_sales",
    "view_customers",
    "view_suppliers",
    "view_purchases",
    "view_insights",
    "view_financials",
    "view_dashboard",
  ]);
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

let A: PayrollTenantSeed;
let B: PayrollTenantSeed;
let hussienSupplierA: string;
let husseinEmployeeA: string;
let onlySupplierA: string;
let husseinSupplierB: string;
let productA: string;
let productA2: string;

beforeAll(async () => {
  A = await seedPayrollTenant("reason-a");
  B = await seedPayrollTenant("reason-b");

  // Tenant A — Hussein appears as BOTH supplier AND employee (the ambiguity case).
  hussienSupplierA = await freshSupplier(A, "حسين للعطور", 7_500);
  husseinEmployeeA = await freshEmployee(A, "حسين");
  // Plus a supplier-only person.
  onlySupplierA = await freshSupplier(A, "محمود المورد", 12_000);

  // Tenant B — same string "حسين" but only as a supplier (cross-tenant probe).
  husseinSupplierB = await freshSupplier(B, "حسين — B");
  void husseinSupplierB;

  // Products for inventory signals
  productA = await seedProduct(A.tenantId, {
    categoryId: A.categoryId,
    branchId: A.branchId,
    name: "Hot Seller",
    price: 1000,
    cost: 500,
  });
  productA2 = await seedProduct(A.tenantId, {
    categoryId: A.categoryId,
    branchId: A.branchId,
    name: "Dead Item",
    price: 2000,
    cost: 1000,
  });
  // Nudge productA into low-stock range
  await withTenant(A.tenantId, async (tx) => {
    await tx
      .update(products)
      .set({ quantity: 1, lowStockThreshold: 5 })
      .where(sql`${products.id} = ${productA}`);
    await tx
      .update(products)
      .set({ quantity: 20 })
      .where(sql`${products.id} = ${productA2}`);
  });

  // A recent sale for productA so it isn't flagged dead too
  await withTenant(A.tenantId, async (tx) => {
    await tx.insert(sales).values({
      tenantId: A.tenantId,
      branchId: A.branchId,
      productId: productA,
      productName: "Hot Seller",
      categoryId: A.categoryId,
      quantitySold: 1,
      pricePerUnit: "1000",
      subtotal: "1000",
      totalPrice: "1000",
      saleDate: new Date(NOW.getTime() - 2 * ONE_DAY),
      customerPhone: "+201000000001",
      customerName: "عميل جديد",
      paymentMethod: "cash",
      isPaid: true,
      amountPaid: "1000",
      invoiceId: "INV-1",
      isReturned: false,
    });
    // Old sale for productA2 → dead stock
    await tx.insert(sales).values({
      tenantId: A.tenantId,
      branchId: A.branchId,
      productId: productA2,
      productName: "Dead Item",
      categoryId: A.categoryId,
      quantitySold: 1,
      pricePerUnit: "2000",
      subtotal: "2000",
      totalPrice: "2000",
      saleDate: new Date(NOW.getTime() - 200 * ONE_DAY),
      customerPhone: "+201000000002",
      customerName: "عميل قديم",
      paymentMethod: "cash",
      isPaid: true,
      amountPaid: "2000",
      invoiceId: "INV-OLD",
      isReturned: false,
    });
  });

  // One received PO for Mahmoud so supplier-payable > 0 and get_top_suppliers has data
  await withTenant(A.tenantId, async (tx) => {
    await tx.insert(purchaseOrders).values({
      tenantId: A.tenantId,
      branchId: A.branchId,
      supplierId: onlySupplierA,
      status: "received",
      total: "12000",
      paidAmount: "0",
      orderDate: new Date(NOW.getTime() - 10 * ONE_DAY),
      receivedDate: new Date(NOW.getTime() - 10 * ONE_DAY),
    });
  });
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

/* ─────────────────── resolve_payment_counterparty ─────────────────── */

describe("resolve_payment_counterparty", () => {
  it("classification='ambiguous' when name matches BOTH supplier and employee", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "resolve_payment_counterparty",
      JSON.stringify({ query: "حسين" }),
    );
    expect(res.ok).toBe(true);
    const data = (res as { data: {
      classification: string;
      supplier: { tier: string };
      employee: { tier: string };
    }}).data;
    expect(data.classification).toBe("ambiguous");
    expect(data.supplier.tier === "HIGH" || data.supplier.tier === "MEDIUM").toBe(true);
    expect(data.employee.tier === "HIGH" || data.employee.tier === "MEDIUM").toBe(true);
  });

  it("classification='supplier_payment' when only a supplier matches", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "resolve_payment_counterparty",
      JSON.stringify({ query: "محمود" }),
    );
    const data = (res as { data: { classification: string; supplier: { candidates: Array<{ name: string }> } } }).data;
    expect(data.classification).toBe("supplier_payment");
    expect(data.supplier.candidates[0].name).toContain("محمود");
  });

  it("classification='no_match' when neither bucket has anyone", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "resolve_payment_counterparty",
      JSON.stringify({ query: "أحد لا يوجد" }),
    );
    const data = (res as { data: { classification: string } }).data;
    expect(data.classification).toBe("no_match");
  });

  it("cross-tenant: B's Hussein supplier isolated from A", async () => {
    const res = await executeTool(
      ownerCtx(B),
      "resolve_payment_counterparty",
      JSON.stringify({ query: "حسين" }),
    );
    const data = (res as { data: {
      supplier: { candidates: Array<{ id: string }> };
      employee: { candidates: Array<{ userId: string }> };
    }}).data;
    // Must ONLY surface B's supplier, never A's
    expect(data.supplier.candidates.find((c) => c.id === hussienSupplierA)).toBeUndefined();
    expect(data.employee.candidates.find((c) => c.userId === husseinEmployeeA)).toBeUndefined();
  });

  it("requires view_suppliers permission", async () => {
    const res = await executeTool(ctxOf(A, "staff", []), "resolve_payment_counterparty", JSON.stringify({ query: "حسين" }));
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });

  it("EMPTY_QUERY when query is blank", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "resolve_payment_counterparty",
      JSON.stringify({ query: "  " }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("EMPTY_QUERY");
  });
});

/* ────────────────────────── get_shop_pulse ────────────────────────── */

describe("get_shop_pulse", () => {
  it("returns a signals list with low_stock + dead_stock + supplier_payable + inventory_value", async () => {
    const res = await executeTool(ownerCtx(A), "get_shop_pulse", "{}");
    expect(res.ok).toBe(true);
    const data = (res as { data: {
      signals: Array<{ key: string; severity: string; count: number }>;
      windowDays: number;
    }}).data;
    const keys = data.signals.map((s) => s.key);
    expect(keys).toContain("low_or_out_of_stock"); // productA has qty=1, threshold=5
    expect(keys).toContain("dead_stock"); // productA2 old sale
    expect(keys).toContain("supplier_payable"); // Mahmoud owed 12000 + Hussein 7500 = 19500
    expect(keys).toContain("inventory_value"); // always emitted as 'info'
    expect(data.windowDays).toBe(60);
  });

  it("severity rank: high → attention → info", async () => {
    const res = await executeTool(ownerCtx(A), "get_shop_pulse", "{}");
    const data = (res as { data: { signals: Array<{ severity: string }> } }).data;
    const rank = { high: 0, attention: 1, info: 2 } as const;
    for (let i = 1; i < data.signals.length; i += 1) {
      expect(rank[data.signals[i - 1].severity as keyof typeof rank])
        .toBeLessThanOrEqual(rank[data.signals[i].severity as keyof typeof rank]);
    }
  });

  it("window_days override is honoured", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_shop_pulse",
      JSON.stringify({ window_days: 30 }),
    );
    const data = (res as { data: { windowDays: number } }).data;
    expect(data.windowDays).toBe(30);
  });

  it("tenant B gets ONLY its own signals — no leak from A", async () => {
    const res = await executeTool(ownerCtx(B), "get_shop_pulse", "{}");
    const data = (res as { data: { signals: Array<{ examples: Array<{ productId?: string }> }> } }).data;
    const anyAProduct = data.signals
      .flatMap((s) => s.examples ?? [])
      .find((ex) => ex.productId === productA || ex.productId === productA2);
    expect(anyAProduct).toBeUndefined();
  });

  it("requires view_insights permission", async () => {
    const res = await executeTool(ctxOf(A, "staff", []), "get_shop_pulse", "{}");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });
});
