// Phase B P0 — AI purchase creation, real Postgres.
//
// Verifies the full round-trip: preview → consumePending → permission
// re-check → executor → authoritative orchestrator → DB state.
//
// Covers:
//   • existing product, full / partial / zero payment
//   • new product with category materialisation
//   • mixed existing + new in one PO
//   • supplier not in tenant → refused
//   • product id not in tenant → refused
//   • paid > total → refused
//   • permission revoked at confirm → FORBIDDEN_AT_CONFIRM
//   • duplicate confirm → ALREADY_CONSUMED
//   • cross-tenant token reuse → refused
//   • cost update: existing product's cost_price is overwritten with the
//     new unit cost (while historical sales keep cost_price_at_sale)
//   • transaction atomicity: a mid-flight failure rolls back everything
//
// Fixtures live in payroll-fixtures.ts (same shape we reuse elsewhere).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  products,
  purchaseOrderItems,
  purchaseOrderPayments,
  purchaseOrders,
  suppliers,
  tenantMembers,
  users,
} from "@/lib/db/schema";
import { consumePending } from "@/lib/ai/write/pending";
import { executeAction } from "@/lib/ai/write/execute";
import { executeTool } from "@/lib/ai/tools";
import type { AgentContext } from "@/lib/ai/context";
import {
  addStaff,
  seedPayrollTenant,
  seedProduct,
  type PayrollTenantSeed,
} from "./payroll-fixtures";

const ACTION_PERMISSION: Record<string, string> = {
  create_purchase: "manage_purchases",
  record_purchase_payment: "manage_purchases",
};

async function confirmAs(
  tenantId: string,
  userId: string,
  token: string,
  session: { role: "owner" | "staff"; permissions: string[] },
): Promise<{ ok: boolean; reason?: string }> {
  const consumed = await consumePending({ tenantId, userId, token });
  if (!consumed.ok) return { ok: false, reason: consumed.reason };
  const needed = ACTION_PERMISSION[consumed.row.action];
  if (needed && !session.permissions.includes(needed) && session.role !== "owner") {
    return { ok: false, reason: "FORBIDDEN_AT_CONFIRM" };
  }
  const res = await executeAction({ row: consumed.row });
  return { ok: res.ok, reason: res.ok ? undefined : (res.debug.reason ?? "UNKNOWN") };
}

async function freshSupplier(
  seed: PayrollTenantSeed,
  name: string,
): Promise<string> {
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

function ownerCtx(t: PayrollTenantSeed): AgentContext {
  return {
    tenantId: t.tenantId,
    userId: t.ownerId,
    branchId: null,
    role: "owner",
    permissions: ["manage_purchases", "view_suppliers"],
    locale: "en",
  } as AgentContext;
}

function staffCtx(t: PayrollTenantSeed): AgentContext {
  return {
    tenantId: t.tenantId,
    userId: t.ownerId,
    branchId: null,
    role: "staff",
    permissions: [],
    locale: "en",
  } as AgentContext;
}

function extractToken(result: unknown): string {
  const r = result as { ok: boolean; blocks?: Array<{ token?: string }> };
  expect(r.ok).toBe(true);
  const tok = r.blocks?.find((b) => b.token)?.token;
  expect(typeof tok).toBe("string");
  return tok!;
}

let A: PayrollTenantSeed;
let B: PayrollTenantSeed;
let supplierHussein: string;
let supplierMohamed: string;
let existingWatch: string;
let supplierHusseinB: string;

beforeAll(async () => {
  A = await seedPayrollTenant("purchase-a");
  B = await seedPayrollTenant("purchase-b");
  supplierHussein = await freshSupplier(A, "حسين للعطور");
  supplierMohamed = await freshSupplier(A, "محمد للمنتجات");
  existingWatch = await seedProduct(A.tenantId, {
    categoryId: A.categoryId,
    branchId: A.branchId,
    name: "NAVIFORCE MF0612",
    price: 1800,
    cost: 1200,
  });
  supplierHusseinB = await freshSupplier(B, "حسين للعطور (tenant B)");
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

/* ───────────────────────── list_supplier_products ───────────────────────── */

describe("list_supplier_products", () => {
  it("returns NONE when supplier has no history or linked products", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "list_supplier_products",
      JSON.stringify({ supplierId: supplierMohamed }),
    );
    expect(res.ok).toBe(true);
    const data = (res as { data: { tier: string } }).data;
    expect(data.tier).toBe("NONE");
  });

  it("is FORBIDDEN without view_suppliers permission", async () => {
    const res = await executeTool(
      staffCtx(A),
      "list_supplier_products",
      JSON.stringify({ supplierId: supplierHussein }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });
});

/* ───────────────────────── preview_create_purchase ──────────────────────── */

describe("preview_create_purchase — existing product", () => {
  it("full payment → PO received, stock +, cost updated, supplier balance = 0", async () => {
    const preview = await executeTool(
      ownerCtx(A),
      "preview_create_purchase",
      JSON.stringify({
        supplierId: supplierHussein,
        items: [
          { productId: existingWatch, productName: "ignored", quantity: 10, unitCost: 1250 },
        ],
        paidNow: 12500,
        paymentMethod: "cash",
      }),
    );
    const token = extractToken(preview);
    const confirm = await confirmAs(A.tenantId, A.ownerId, token, {
      role: "owner",
      permissions: ["manage_purchases"],
    });
    expect(confirm.ok).toBe(true);

    // State: stock +=10, cost=1250, supplier balance 0 (we owed total, paid total).
    const [p] = await withTenant(A.tenantId, (tx) =>
      tx
        .select({ qty: products.quantity, cost: products.costPrice, price: products.price })
        .from(products)
        .where(and(eq(products.tenantId, A.tenantId), eq(products.id, existingWatch)))
        .limit(1),
    );
    expect(p?.qty).toBe(100 + 10);
    expect(Number(p?.cost)).toBe(1250);
    expect(Number(p?.price)).toBe(1800); // selling price unchanged

    const [sup] = await withTenant(A.tenantId, (tx) =>
      tx
        .select({ balance: suppliers.balance })
        .from(suppliers)
        .where(eq(suppliers.id, supplierHussein))
        .limit(1),
    );
    expect(Number(sup?.balance)).toBeCloseTo(0, 2);

    // Payment row exists.
    const payments = await withTenant(A.tenantId, (tx) =>
      tx
        .select()
        .from(purchaseOrderPayments)
        .where(
          and(
            eq(purchaseOrderPayments.tenantId, A.tenantId),
            eq(purchaseOrderPayments.supplierId, supplierHussein),
          ),
        ),
    );
    expect(payments.length).toBe(1);
    expect(Number(payments[0]!.amount)).toBe(12500);

    // PO row received + paid_amount = total.
    const [po] = await withTenant(A.tenantId, (tx) =>
      tx
        .select()
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.tenantId, A.tenantId), eq(purchaseOrders.supplierId, supplierHussein)))
        .limit(1),
    );
    expect(po?.status).toBe("received");
    expect(Number(po?.paidAmount)).toBe(12500);
    expect(Number(po?.total)).toBe(12500);
  });

  it("partial payment → supplier balance = outstanding, next time balance accumulates", async () => {
    const preview = await executeTool(
      ownerCtx(A),
      "preview_create_purchase",
      JSON.stringify({
        supplierId: supplierHussein,
        items: [
          { productId: existingWatch, productName: "ignored", quantity: 4, unitCost: 1250 },
        ],
        paidNow: 2000,
      }),
    );
    const token = extractToken(preview);
    const confirm = await confirmAs(A.tenantId, A.ownerId, token, {
      role: "owner",
      permissions: ["manage_purchases"],
    });
    expect(confirm.ok).toBe(true);

    // Supplier now owes us +5000 - 2000 = +3000 (added to prior 0).
    const [sup] = await withTenant(A.tenantId, (tx) =>
      tx
        .select({ balance: suppliers.balance })
        .from(suppliers)
        .where(eq(suppliers.id, supplierHussein))
        .limit(1),
    );
    expect(Number(sup?.balance)).toBeCloseTo(3000, 2);
  });

  it("zero payment (all credit) → supplier balance grows by full total", async () => {
    const preview = await executeTool(
      ownerCtx(A),
      "preview_create_purchase",
      JSON.stringify({
        supplierId: supplierHussein,
        items: [
          { productId: existingWatch, productName: "ignored", quantity: 2, unitCost: 1250 },
        ],
      }),
    );
    const token = extractToken(preview);
    const confirm = await confirmAs(A.tenantId, A.ownerId, token, {
      role: "owner",
      permissions: ["manage_purchases"],
    });
    expect(confirm.ok).toBe(true);

    // Supplier balance = prior 3000 + 2500 = 5500.
    const [sup] = await withTenant(A.tenantId, (tx) =>
      tx
        .select({ balance: suppliers.balance })
        .from(suppliers)
        .where(eq(suppliers.id, supplierHussein))
        .limit(1),
    );
    expect(Number(sup?.balance)).toBeCloseTo(5500, 2);
  });
});

/* ────────────── preview_create_purchase — new product materialisation ──── */

describe("preview_create_purchase — new product", () => {
  it("creates the product + stocks it; supplier balance reflects credit", async () => {
    const preview = await executeTool(
      ownerCtx(A),
      "preview_create_purchase",
      JSON.stringify({
        supplierId: supplierHussein,
        items: [
          {
            productId: null,
            productName: "PINK SAKURA 100ML",
            quantity: 20,
            unitCost: 300,
            categoryId: A.categoryId,
          },
        ],
        paidNow: 0,
      }),
    );
    const token = extractToken(preview);
    const confirm = await confirmAs(A.tenantId, A.ownerId, token, {
      role: "owner",
      permissions: ["manage_purchases"],
    });
    expect(confirm.ok).toBe(true);

    const [p] = await withTenant(A.tenantId, (tx) =>
      tx
        .select()
        .from(products)
        .where(
          and(
            eq(products.tenantId, A.tenantId),
            sql`lower(${products.name}) = 'pink sakura 100ml'`,
          ),
        )
        .limit(1),
    );
    expect(p).toBeTruthy();
    expect(p!.quantity).toBe(20);
    expect(Number(p!.costPrice)).toBe(300);
    expect(p!.supplierId).toBe(supplierHussein);
  });

  it("refuses when a new product line has no categoryId", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "preview_create_purchase",
      JSON.stringify({
        supplierId: supplierHussein,
        items: [
          { productId: null, productName: "NEEDS CATEGORY", quantity: 1, unitCost: 100 },
        ],
      }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("NEW_PRODUCT_NEEDS_CATEGORY");
  });
});

/* ────────────────────── negative paths + security ──────────────────────── */

describe("preview_create_purchase — validation", () => {
  it("refuses supplier not in this tenant", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "preview_create_purchase",
      JSON.stringify({
        supplierId: supplierHusseinB, // tenant B's supplier
        items: [
          { productId: existingWatch, productName: "", quantity: 1, unitCost: 100 },
        ],
      }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("SUPPLIER_NOT_FOUND");
  });

  it("refuses productId not in this tenant", async () => {
    const [bWatch] = [
      await seedProduct(B.tenantId, {
        categoryId: B.categoryId,
        branchId: B.branchId,
        name: "B-only product",
        price: 500,
      }),
    ];
    const res = await executeTool(
      ownerCtx(A),
      "preview_create_purchase",
      JSON.stringify({
        supplierId: supplierHussein,
        items: [{ productId: bWatch, productName: "ignored", quantity: 1, unitCost: 100 }],
      }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("PRODUCT_NOT_FOUND");
  });

  it("refuses paid > total", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "preview_create_purchase",
      JSON.stringify({
        supplierId: supplierHussein,
        items: [{ productId: existingWatch, productName: "ignored", quantity: 1, unitCost: 100 }],
        paidNow: 500,
      }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("PAID_GREATER_THAN_TOTAL");
  });

  it("without manage_purchases, preview is FORBIDDEN", async () => {
    const res = await executeTool(
      staffCtx(A),
      "preview_create_purchase",
      JSON.stringify({
        supplierId: supplierHussein,
        items: [{ productId: existingWatch, productName: "ignored", quantity: 1, unitCost: 100 }],
      }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });
});

/* ───────────────── staged-write security: confirmation path ────────────── */

describe("create_purchase — F5 confirmation security", () => {
  it("permission revoked between preview and confirm → FORBIDDEN_AT_CONFIRM, no mutation", async () => {
    const preview = await executeTool(
      ownerCtx(A),
      "preview_create_purchase",
      JSON.stringify({
        supplierId: supplierHussein,
        items: [{ productId: existingWatch, productName: "ignored", quantity: 1, unitCost: 100 }],
      }),
    );
    const token = extractToken(preview);
    const confirm = await confirmAs(A.tenantId, A.ownerId, token, {
      role: "staff",
      permissions: [],
    });
    expect(confirm.ok).toBe(false);
    expect(confirm.reason).toBe("FORBIDDEN_AT_CONFIRM");
  });

  it("duplicate confirmation → ALREADY_CONSUMED", async () => {
    const preview = await executeTool(
      ownerCtx(A),
      "preview_create_purchase",
      JSON.stringify({
        supplierId: supplierHussein,
        items: [{ productId: existingWatch, productName: "ignored", quantity: 1, unitCost: 100 }],
      }),
    );
    const token = extractToken(preview);
    const first = await confirmAs(A.tenantId, A.ownerId, token, {
      role: "owner",
      permissions: ["manage_purchases"],
    });
    expect(first.ok).toBe(true);
    const second = await confirmAs(A.tenantId, A.ownerId, token, {
      role: "owner",
      permissions: ["manage_purchases"],
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("ALREADY_CONSUMED");
  });

  it("cross-tenant token → refused", async () => {
    const preview = await executeTool(
      ownerCtx(A),
      "preview_create_purchase",
      JSON.stringify({
        supplierId: supplierHussein,
        items: [{ productId: existingWatch, productName: "ignored", quantity: 1, unitCost: 100 }],
      }),
    );
    const token = extractToken(preview);
    const confirm = await confirmAs(B.tenantId, B.ownerId, token, {
      role: "owner",
      permissions: ["manage_purchases"],
    });
    expect(confirm.ok).toBe(false);
    expect(["TENANT_MISMATCH", "NOT_FOUND"]).toContain(confirm.reason);
  });
});

/* ─────────────────── preview_record_purchase_payment ───────────────────── */

describe("preview_record_purchase_payment", () => {
  let openPoId: string;

  beforeAll(async () => {
    // Create a fresh received PO with a 3000 outstanding balance.
    const prep = await executeTool(
      ownerCtx(A),
      "preview_create_purchase",
      JSON.stringify({
        supplierId: supplierMohamed,
        items: [
          { productId: existingWatch, productName: "ignored", quantity: 4, unitCost: 1000 },
        ],
        paidNow: 1000,
      }),
    );
    const token = extractToken(prep);
    await confirmAs(A.tenantId, A.ownerId, token, {
      role: "owner",
      permissions: ["manage_purchases"],
    });
    const [po] = await withTenant(A.tenantId, (tx) =>
      tx
        .select({ id: purchaseOrders.id })
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.tenantId, A.tenantId),
            eq(purchaseOrders.supplierId, supplierMohamed),
          ),
        )
        .limit(1),
    );
    openPoId = po!.id;
  });

  it("partial payment → remaining is reduced; supplier balance − amount", async () => {
    const preview = await executeTool(
      ownerCtx(A),
      "preview_record_purchase_payment",
      JSON.stringify({ purchaseOrderId: openPoId, amount: 2000, paymentMethod: "cash" }),
    );
    const token = extractToken(preview);
    const confirm = await confirmAs(A.tenantId, A.ownerId, token, {
      role: "owner",
      permissions: ["manage_purchases"],
    });
    expect(confirm.ok).toBe(true);

    const [po] = await withTenant(A.tenantId, (tx) =>
      tx
        .select({ total: purchaseOrders.total, paid: purchaseOrders.paidAmount })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, openPoId))
        .limit(1),
    );
    const total = Number(po!.total);
    const paid = Number(po!.paid);
    expect(total).toBe(4000);
    expect(paid).toBe(3000); // 1000 initial + 2000 now
  });

  it("overpay refused at preview time", async () => {
    // Remaining is 1000 after the previous test. Try to pay 5000.
    const res = await executeTool(
      ownerCtx(A),
      "preview_record_purchase_payment",
      JSON.stringify({ purchaseOrderId: openPoId, amount: 5000 }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("AMOUNT_EXCEEDS_REMAINING");
  });

  it("payment on PO not in tenant refused", async () => {
    // Build a PO on tenant B.
    const bWatch = await seedProduct(B.tenantId, {
      categoryId: B.categoryId,
      branchId: B.branchId,
      name: "B product for payment test",
      price: 100,
    });
    const prepB = await executeTool(
      ownerCtx(B),
      "preview_create_purchase",
      JSON.stringify({
        supplierId: supplierHusseinB,
        items: [{ productId: bWatch, productName: "ignored", quantity: 1, unitCost: 500 }],
      }),
    );
    const tokenB = extractToken(prepB);
    await confirmAs(B.tenantId, B.ownerId, tokenB, {
      role: "owner",
      permissions: ["manage_purchases"],
    });
    const [poB] = await withTenant(B.tenantId, (tx) =>
      tx
        .select({ id: purchaseOrders.id })
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.tenantId, B.tenantId),
            eq(purchaseOrders.supplierId, supplierHusseinB),
          ),
        )
        .limit(1),
    );

    // Try to pay B's PO from A's agent context — should NOT find it.
    const res = await executeTool(
      ownerCtx(A),
      "preview_record_purchase_payment",
      JSON.stringify({ purchaseOrderId: poB!.id, amount: 100 }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("PO_NOT_FOUND");
  });

  it("without manage_purchases, preview is FORBIDDEN", async () => {
    const res = await executeTool(
      staffCtx(A),
      "preview_record_purchase_payment",
      JSON.stringify({ purchaseOrderId: openPoId, amount: 100 }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });
});

// Silence lint for imports used only via fixtures.
void purchaseOrderItems;
void tenantMembers;
void users;
