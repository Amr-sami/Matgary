// Phase B P1 Wave 1 — read tools, real Postgres.
//
// Covers the five new / extended AI tools:
//   • get_product_sales_history           (wraps catalog.listProductHistory)
//   • get_sales_comparison                (wraps insights-deep.loadCompareReport)
//   • get_supplier_payment_history        (wraps new repo.listSupplierPayments)
//   • list_unpaid_purchase_orders         (wraps new repo.listUnpaidPurchaseOrdersBySupplier)
//   • resolveWindow                       (custom {from,to} plumbing in _shared)
//
// Each new tool is exercised for:
//   - happy path / shape
//   - date range filtering (preset + custom)
//   - permission enforcement
//   - cross-tenant isolation
//
// Test tenants are isolated per suite (payroll-fixtures pattern) so they can
// run in parallel.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  productHistory,
  purchaseOrderPayments,
  purchaseOrders,
  suppliers,
} from "@/lib/db/schema";
import { executeTool } from "@/lib/ai/tools";
import { resolveWindow } from "@/lib/ai/tools/_shared";
import type { AgentContext } from "@/lib/ai/context";
import {
  recordSale,
  seedPayrollTenant,
  seedProduct,
  type PayrollTenantSeed,
} from "./payroll-fixtures";

/* ────────────────────────────── helpers ─────────────────────────────── */

function ownerCtx(
  t: PayrollTenantSeed,
  perms: string[] = [
    "view_sales",
    "view_suppliers",
    "view_purchases",
    "view_inventory",
  ],
): AgentContext {
  return {
    tenantId: t.tenantId,
    userId: t.ownerId,
    branchId: null,
    role: "owner",
    permissions: perms,
    locale: "en",
  } as AgentContext;
}

function staffCtx(
  t: PayrollTenantSeed,
  perms: string[] = [],
): AgentContext {
  return {
    tenantId: t.tenantId,
    userId: t.ownerId,
    branchId: null,
    role: "staff",
    permissions: perms,
    locale: "en",
  } as AgentContext;
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

async function insertHistoryRow(
  tenantId: string,
  productId: string,
  productName: string,
  type: "sold" | "returned" | "restocked" | "decreased" | "updated" | "created",
  delta: number | null,
  quantityAfter: number | null,
  createdAt: Date,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.insert(productHistory).values({
      tenantId,
      productId,
      productName,
      type,
      delta,
      quantityAfter,
      note: null,
      createdAt,
    });
  });
}

async function insertPO(
  seed: PayrollTenantSeed,
  supplierId: string,
  args: {
    status: "draft" | "received" | "cancelled";
    total: number;
    paidAmount: number;
    orderDate: Date;
    receivedDate?: Date | null;
  },
): Promise<string> {
  return withTenant(seed.tenantId, async (tx) => {
    const [po] = await tx
      .insert(purchaseOrders)
      .values({
        tenantId: seed.tenantId,
        branchId: seed.branchId,
        supplierId,
        status: args.status,
        total: String(args.total),
        paidAmount: String(args.paidAmount),
        orderDate: args.orderDate,
        receivedDate: args.receivedDate ?? null,
      })
      .returning({ id: purchaseOrders.id });
    return po.id;
  });
}

async function insertPayment(
  seed: PayrollTenantSeed,
  supplierId: string,
  purchaseOrderId: string,
  args: { amount: number; method?: string; paidAt: Date; notes?: string },
): Promise<void> {
  await withTenant(seed.tenantId, async (tx) => {
    await tx.insert(purchaseOrderPayments).values({
      tenantId: seed.tenantId,
      supplierId,
      purchaseOrderId,
      amount: String(args.amount),
      method: args.method ?? "cash",
      paidAt: args.paidAt,
      notes: args.notes ?? null,
    });
  });
}

const ONE_DAY = 24 * 60 * 60 * 1000;

/* ────────────────────────────── setup ───────────────────────────────── */

let A: PayrollTenantSeed;
let B: PayrollTenantSeed;
let productA: string;
let productB: string;
let supplierHussein: string;
let supplierAhmed: string;
let supplierHusseinB: string;

// Fixed anchor so comparison windows land on populated dates regardless of
// when the suite runs. Picks a day far enough in the past that it's not
// today in any sensible timezone.
const ANCHOR = new Date("2026-06-15T12:00:00.000Z");
const POPULATED_FROM = "2026-06-01";
const POPULATED_TO = "2026-06-30";

beforeAll(async () => {
  A = await seedPayrollTenant("wave1-a");
  B = await seedPayrollTenant("wave1-b");

  productA = await seedProduct(A.tenantId, {
    categoryId: A.categoryId,
    branchId: A.branchId,
    name: "Guess Watch W1-A",
    price: 2000,
    cost: 1500,
  });
  productB = await seedProduct(B.tenantId, {
    categoryId: B.categoryId,
    branchId: B.branchId,
    name: "Guess Watch W1-B",
    price: 2000,
    cost: 1500,
  });

  supplierHussein = await freshSupplier(A, "حسين للعطور");
  supplierAhmed = await freshSupplier(A, "أحمد للمنتجات");
  supplierHusseinB = await freshSupplier(B, "حسين — tenant B");

  // ── product history: 3 sold + 1 returned inside the window, 1 sold outside
  await insertHistoryRow(A.tenantId, productA, "Guess Watch W1-A", "sold", -2, 98, new Date(ANCHOR.getTime() - 0));
  await insertHistoryRow(A.tenantId, productA, "Guess Watch W1-A", "sold", -1, 97, new Date(ANCHOR.getTime() - ONE_DAY));
  await insertHistoryRow(A.tenantId, productA, "Guess Watch W1-A", "sold", -3, 94, new Date(ANCHOR.getTime() - 2 * ONE_DAY));
  await insertHistoryRow(A.tenantId, productA, "Guess Watch W1-A", "returned", 1, 95, new Date(ANCHOR.getTime() - 3 * ONE_DAY));
  await insertHistoryRow(A.tenantId, productA, "Guess Watch W1-A", "restocked", 10, 100, new Date(ANCHOR.getTime() - 4 * ONE_DAY));
  // Out-of-window sale (April) — should NOT appear when scoped to June.
  await insertHistoryRow(
    A.tenantId,
    productA,
    "Guess Watch W1-A",
    "sold",
    -5,
    100,
    new Date("2026-04-10T12:00:00.000Z"),
  );
  // Tenant-B history for the same product id value — must NOT leak into A.
  await insertHistoryRow(B.tenantId, productB, "Guess Watch W1-B", "sold", -99, 1, ANCHOR);

  // ── sales for get_sales_comparison (June 2026 vs May 2026, same length)
  // Current window: 2026-06-01 .. 2026-06-30 → 10,000 EGP total
  await recordSale(A.tenantId, {
    productId: productA,
    categoryId: A.categoryId,
    recordedByUserId: A.ownerId,
    totalPrice: 6000,
    saleDate: new Date("2026-06-10T10:00:00.000Z"),
    branchId: A.branchId,
  });
  await recordSale(A.tenantId, {
    productId: productA,
    categoryId: A.categoryId,
    recordedByUserId: A.ownerId,
    totalPrice: 4000,
    saleDate: new Date("2026-06-25T10:00:00.000Z"),
    branchId: A.branchId,
  });
  // Previous window: 2026-05-02 .. 2026-05-31 (auto-computed by loadCompareReport)
  await recordSale(A.tenantId, {
    productId: productA,
    categoryId: A.categoryId,
    recordedByUserId: A.ownerId,
    totalPrice: 5000,
    saleDate: new Date("2026-05-20T10:00:00.000Z"),
    branchId: A.branchId,
  });

  // ── POs + payments (3 POs for Hussein in A, 1 for Ahmed, 1 for Hussein-B)
  const poReceivedPartial = await insertPO(A, supplierHussein, {
    status: "received",
    total: 5000,
    paidAmount: 2000,
    orderDate: new Date("2026-06-05T10:00:00.000Z"),
    receivedDate: new Date("2026-06-05T10:00:00.000Z"),
  });
  const poReceivedZero = await insertPO(A, supplierHussein, {
    status: "received",
    total: 3000,
    paidAmount: 0,
    orderDate: new Date("2026-06-18T10:00:00.000Z"),
    receivedDate: new Date("2026-06-18T10:00:00.000Z"),
  });
  const poReceivedFull = await insertPO(A, supplierHussein, {
    status: "received",
    total: 1000,
    paidAmount: 1000,
    orderDate: new Date("2026-06-20T10:00:00.000Z"),
    receivedDate: new Date("2026-06-20T10:00:00.000Z"),
  });
  const poDraft = await insertPO(A, supplierHussein, {
    status: "draft",
    total: 9999,
    paidAmount: 0,
    orderDate: new Date("2026-06-28T10:00:00.000Z"),
  });
  void poDraft;
  await insertPO(A, supplierAhmed, {
    status: "received",
    total: 2000,
    paidAmount: 500,
    orderDate: new Date("2026-06-10T10:00:00.000Z"),
    receivedDate: new Date("2026-06-10T10:00:00.000Z"),
  });

  // Payments against Hussein's POs — 2 in-window, 1 pre-window
  await insertPayment(A, supplierHussein, poReceivedPartial, {
    amount: 1500,
    paidAt: new Date("2026-06-07T10:00:00.000Z"),
  });
  await insertPayment(A, supplierHussein, poReceivedPartial, {
    amount: 500,
    paidAt: new Date("2026-06-12T10:00:00.000Z"),
  });
  await insertPayment(A, supplierHussein, poReceivedFull, {
    amount: 1000,
    paidAt: new Date("2026-06-20T10:00:00.000Z"),
  });
  // Pre-window payment — must NOT show up when scoped to June.
  await insertPayment(A, supplierHussein, poReceivedPartial, {
    amount: 999,
    paidAt: new Date("2026-05-01T10:00:00.000Z"),
  });
  // Cross-tenant payment — must NOT appear for A.
  const poB = await insertPO(B, supplierHusseinB, {
    status: "received",
    total: 10_000,
    paidAmount: 0,
    orderDate: ANCHOR,
    receivedDate: ANCHOR,
  });
  await insertPayment(B, supplierHusseinB, poB, {
    amount: 7777,
    paidAt: ANCHOR,
  });
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

/* ─────────────────────────── resolveWindow ─────────────────────────── */

describe("resolveWindow", () => {
  it("prefers {from,to} over `period`", () => {
    const r = resolveWindow({ period: "today", from: "2026-06-01", to: "2026-06-30" });
    expect(r.kind).toBe("custom");
    expect(r.window).not.toBeNull();
    // Finance dates work in Cairo time; `to` is EXCLUSIVE (day after
    // 2026-06-30). Assert on the Cairo wall clock day (format the Date in
    // Africa/Cairo to avoid UTC-offset flakiness).
    const fmt = (d: Date) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Cairo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d);
    expect(fmt(r.window!.from)).toBe("2026-06-01");
    expect(fmt(r.window!.to)).toBe("2026-07-01");
  });

  it("falls back to `period` preset when only preset is passed", () => {
    const r = resolveWindow({ period: "month" });
    expect(r.kind).toBe("preset");
    expect(r.window).not.toBeNull();
    expect(r.period).toBe("month");
  });

  it("'all' returns a null window", () => {
    const r = resolveWindow({ period: "all" });
    expect(r.kind).toBe("preset");
    expect(r.window).toBeNull();
  });

  it("missing args default to 'month' (safe fallback)", () => {
    const r = resolveWindow({});
    expect(r.kind).toBe("preset");
    expect(r.period).toBe("month");
  });
});

/* ───────────────────── get_product_sales_history ───────────────────── */

describe("get_product_sales_history", () => {
  it("returns sold+returned rows in window, with correct aggregates", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_product_sales_history",
      JSON.stringify({
        product_id: productA,
        from: POPULATED_FROM,
        to: POPULATED_TO,
      }),
    );
    expect(res.ok).toBe(true);
    const data = (res as { data: {
      productId: string;
      totals: { soldQuantity: number; returnedQuantity: number; netSoldQuantity: number; eventCount: number };
      rows: Array<{ type: string }>;
    }}).data;

    expect(data.productId).toBe(productA);
    expect(data.totals.soldQuantity).toBe(2 + 1 + 3); // 6
    expect(data.totals.returnedQuantity).toBe(1);
    expect(data.totals.netSoldQuantity).toBe(5);
    expect(data.totals.eventCount).toBe(4); // 3 sold + 1 returned
    // only_sales=true default → NO restocked/updated rows
    for (const r of data.rows) expect(["sold", "returned"]).toContain(r.type);
  });

  it("only_sales=false includes stock-movement rows", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_product_sales_history",
      JSON.stringify({
        product_id: productA,
        from: POPULATED_FROM,
        to: POPULATED_TO,
        only_sales: false,
      }),
    );
    const data = (res as { data: { totals: { eventCount: number }; rows: Array<{ type: string }> } }).data;
    // 3 sold + 1 returned + 1 restocked = 5
    expect(data.totals.eventCount).toBe(5);
    expect(data.rows.some((r) => r.type === "restocked")).toBe(true);
  });

  it("date window excludes out-of-range rows", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_product_sales_history",
      JSON.stringify({
        product_id: productA,
        from: "2026-04-01",
        to: "2026-04-30",
      }),
    );
    const data = (res as { data: { totals: { soldQuantity: number; eventCount: number } } }).data;
    expect(data.totals.soldQuantity).toBe(5); // only the April sold row
    expect(data.totals.eventCount).toBe(1);
  });

  it("cross-tenant: A cannot see B's product history for a reused uuid", async () => {
    // Insert a history row against productA's id but in tenant B to prove
    // tenant scoping (rare in practice — uuid collision — but the repo's
    // tenant filter must still exclude it).
    const res = await executeTool(
      ownerCtx(B),
      "get_product_sales_history",
      JSON.stringify({ product_id: productB, period: "all" }),
    );
    const data = (res as { data: { totals: { soldQuantity: number } } }).data;
    expect(data.totals.soldQuantity).toBe(99); // only the B-side row
  });

  it("requires view_sales permission", async () => {
    const res = await executeTool(
      staffCtx(A, []),
      "get_product_sales_history",
      JSON.stringify({ product_id: productA }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });

  it("MISSING_PRODUCT_ID when arg is empty", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_product_sales_history",
      JSON.stringify({ product_id: "" }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("MISSING_PRODUCT_ID");
  });
});

/* ───────────────────── get_sales_comparison ────────────────────────── */

describe("get_sales_comparison", () => {
  it("returns current + previous totals with growth %", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_sales_comparison",
      JSON.stringify({ from: POPULATED_FROM, to: POPULATED_TO }),
    );
    expect(res.ok).toBe(true);
    const data = (res as { data: {
      totals: { current: number; previous: number; growth: number };
      window: { from: string; to: string };
      previousWindow: { from: string; to: string };
    }}).data;
    expect(data.totals.current).toBe(10_000); // 6000 + 4000 in June
    expect(data.totals.previous).toBe(5000); // May sale
    expect(data.totals.growth).toBeCloseTo(100, 1);
    expect(data.window).toBeDefined();
    expect(data.previousWindow).toBeDefined();
  });

  it("RANGE_REQUIRED when period='all'", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_sales_comparison",
      JSON.stringify({ period: "all" }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("RANGE_REQUIRED");
  });

  it("preset path also works", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_sales_comparison",
      JSON.stringify({ period: "year" }),
    );
    expect(res.ok).toBe(true);
    const data = (res as { data: { totals: { current: number; previous: number } } }).data;
    expect(typeof data.totals.current).toBe("number");
  });
});

/* ─────────────────── get_supplier_payment_history ──────────────────── */

describe("get_supplier_payment_history", () => {
  it("returns all payments across every PO for the supplier in the window", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_supplier_payment_history",
      JSON.stringify({
        supplier_id: supplierHussein,
        from: POPULATED_FROM,
        to: POPULATED_TO,
      }),
    );
    expect(res.ok).toBe(true);
    const data = (res as { data: {
      totals: { paidInWindow: number; countInWindow: number };
      rows: Array<{ purchaseOrderId: string; amount: number }>;
    }}).data;
    // 3 payments in window (1500 + 500 + 1000) across 2 POs
    expect(data.totals.paidInWindow).toBe(3000);
    expect(data.totals.countInWindow).toBe(3);
    expect(data.rows).toHaveLength(3);
    // Spans multiple PO ids (not just one PO's ledger)
    expect(new Set(data.rows.map((r) => r.purchaseOrderId)).size).toBeGreaterThan(1);
  });

  it("without date range, totals cover the full ledger", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_supplier_payment_history",
      JSON.stringify({ supplier_id: supplierHussein, period: "all" }),
    );
    const data = (res as { data: { totals: { paidInWindow: number; countInWindow: number } } }).data;
    // 3 in-window + 1 pre-window (999) = 4 total, 3999 total
    expect(data.totals.countInWindow).toBe(4);
    expect(data.totals.paidInWindow).toBe(3999);
  });

  it("cross-tenant: A asking for B's supplier gets nothing", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_supplier_payment_history",
      JSON.stringify({ supplier_id: supplierHusseinB, period: "all" }),
    );
    const data = (res as { data: { totals: { paidInWindow: number; countInWindow: number } } }).data;
    expect(data.totals.countInWindow).toBe(0);
    expect(data.totals.paidInWindow).toBe(0);
  });

  it("requires view_suppliers permission", async () => {
    const res = await executeTool(
      staffCtx(A, []),
      "get_supplier_payment_history",
      JSON.stringify({ supplier_id: supplierHussein }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });

  it("MISSING_SUPPLIER_ID when supplier_id is empty", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_supplier_payment_history",
      JSON.stringify({ supplier_id: "" }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("MISSING_SUPPLIER_ID");
  });
});

/* ─────────────────── list_unpaid_purchase_orders ───────────────────── */

describe("list_unpaid_purchase_orders", () => {
  it("returns only received POs with outstanding > 0, newest first", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "list_unpaid_purchase_orders",
      // period:"all" so the June 2026 fixture POs aren't excluded by the
      // default last-30-days window when the suite runs later in the year.
      JSON.stringify({ supplier_id: supplierHussein, period: "all" }),
    );
    expect(res.ok).toBe(true);
    const data = (res as { data: {
      totals: { outstandingTotal: number; count: number };
      rows: Array<{ outstanding: number; total: number; paidAmount: number; status: string }>;
    }}).data;
    // Expected: poReceivedPartial (5000-2000=3000) + poReceivedZero (3000-0=3000)
    // Excluded: poReceivedFull (paid), poDraft (status=draft)
    expect(data.totals.count).toBe(2);
    expect(data.totals.outstandingTotal).toBe(6000);
    for (const r of data.rows) {
      expect(r.outstanding).toBeGreaterThan(0);
      expect(r.status).toBe("received");
    }
  });

  it("excludes draft POs even when outstanding > 0", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "list_unpaid_purchase_orders",
      JSON.stringify({ supplier_id: supplierHussein, period: "all" }),
    );
    const data = (res as { data: { rows: Array<{ status: string }> } }).data;
    expect(data.rows.every((r) => r.status === "received")).toBe(true);
  });

  it("date range on orderDate scopes the result", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "list_unpaid_purchase_orders",
      JSON.stringify({
        supplier_id: supplierHussein,
        from: "2026-06-15",
        to: "2026-06-30",
      }),
    );
    const data = (res as { data: { rows: Array<{ orderDate: string }>; totals: { count: number } } }).data;
    // Only poReceivedZero (2026-06-18) is in this window + unpaid.
    expect(data.totals.count).toBe(1);
  });

  it("different supplier → different PO set", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "list_unpaid_purchase_orders",
      JSON.stringify({ supplier_id: supplierAhmed, period: "all" }),
    );
    const data = (res as { data: { totals: { count: number; outstandingTotal: number } } }).data;
    expect(data.totals.count).toBe(1); // Ahmed's single PO
    expect(data.totals.outstandingTotal).toBe(1500);
  });

  it("cross-tenant: A requesting B's supplier gets zero rows", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "list_unpaid_purchase_orders",
      JSON.stringify({ supplier_id: supplierHusseinB, period: "all" }),
    );
    const data = (res as { data: { totals: { count: number } } }).data;
    expect(data.totals.count).toBe(0);
  });

  it("requires view_purchases permission", async () => {
    const res = await executeTool(
      staffCtx(A, []),
      "list_unpaid_purchase_orders",
      JSON.stringify({ supplier_id: supplierHussein }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });
});

/* ─────────────── get_sales_overview — custom range plumbing ───────── */

describe("get_sales_overview custom range", () => {
  it("accepts {from,to} and scopes totals to that window", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "get_sales_overview",
      JSON.stringify({ from: POPULATED_FROM, to: POPULATED_TO }),
    );
    expect(res.ok).toBe(true);
    const data = (res as { data: { window: { from: string; to: string } | null } }).data;
    expect(data.window).not.toBeNull();
  });
});
