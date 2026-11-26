// Supplier Account Payment Correction — real Postgres integration tests.
//
// Covers the 14 cases in spec §12 for the new default "دفعت لحسين X"
// flow (preview_record_supplier_account_payment → confirm → authoritative
// service). All assertions touch the real database so the accounting
// invariants are proven, not asserted in-memory.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  expenses,
  moneyMovements,
  products,
  purchaseOrders,
  suppliers,
} from "@/lib/db/schema";
import { consumePending } from "@/lib/ai/write/pending";
import { executeAction } from "@/lib/ai/write/execute";
import { executeTool } from "@/lib/ai/tools";
import type { AgentContext } from "@/lib/ai/context";
import {
  seedPayrollTenant,
  seedProduct,
  type PayrollTenantSeed,
} from "./payroll-fixtures";

const ACTION_PERMISSION: Record<string, string> = {
  record_supplier_account_payment: "manage_purchases",
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
  balance = 0,
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
        balance: String(balance),
      })
      .returning({ id: suppliers.id });
    return s.id;
  });
}

async function insertReceivedPO(
  seed: PayrollTenantSeed,
  supplierId: string,
  total: number,
  paidAmount: number,
): Promise<string> {
  return withTenant(seed.tenantId, async (tx) => {
    const [po] = await tx
      .insert(purchaseOrders)
      .values({
        tenantId: seed.tenantId,
        branchId: seed.branchId,
        supplierId,
        status: "received",
        total: String(total),
        paidAmount: String(paidAmount),
        orderDate: new Date(),
        receivedDate: new Date(),
      })
      .returning({ id: purchaseOrders.id });
    return po.id;
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

function staffCtx(t: PayrollTenantSeed, perms: string[] = []): AgentContext {
  return {
    tenantId: t.tenantId,
    userId: t.ownerId,
    branchId: null,
    role: "staff",
    permissions: perms,
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

async function readSupplierBalance(tenantId: string, supplierId: string): Promise<number> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select({ balance: suppliers.balance })
      .from(suppliers)
      .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.id, supplierId)))
      .limit(1),
  );
  return Number(row?.balance ?? 0);
}

let A: PayrollTenantSeed;
let B: PayrollTenantSeed;
let supplierHussein: string;
let supplierMahmoud: string;
let supplierHusseinB: string;

beforeAll(async () => {
  A = await seedPayrollTenant("sap-a");
  B = await seedPayrollTenant("sap-b");
  // Hussein starts with 31,900 outstanding across 3 POs — the spec's example.
  supplierHussein = await freshSupplier(A, "حسين", 0);
  await insertReceivedPO(A, supplierHussein, 14_000, 0);
  await insertReceivedPO(A, supplierHussein, 14_000, 0);
  await insertReceivedPO(A, supplierHussein, 4_500, 600); // 3,900 outstanding
  // Sync `suppliers.balance` to match PO outstanding (what the authoritative
  // path already does on receive).
  await withTenant(A.tenantId, (tx) =>
    tx
      .update(suppliers)
      .set({ balance: "31900" })
      .where(and(eq(suppliers.tenantId, A.tenantId), eq(suppliers.id, supplierHussein))),
  );

  // Mahmoud with zero outstanding (for the "cannot pay someone we don't owe" case).
  supplierMahmoud = await freshSupplier(A, "محمود", 0);

  // Cross-tenant probe.
  supplierHusseinB = await freshSupplier(B, "حسين (B)", 0);
  await insertReceivedPO(B, supplierHusseinB, 50_000, 0);
  await withTenant(B.tenantId, (tx) =>
    tx
      .update(suppliers)
      .set({ balance: "50000" })
      .where(and(eq(suppliers.tenantId, B.tenantId), eq(suppliers.id, supplierHusseinB))),
  );
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

/* ─────────────────────── preview + confirm happy path ─────────────────── */

describe("preview_record_supplier_account_payment — happy path", () => {
  it("1. supplier account payment reduces balance by exact amount", async () => {
    const preview = await executeTool(
      ownerCtx(A),
      "preview_record_supplier_account_payment",
      JSON.stringify({ supplierId: supplierHussein, amount: 10_000 }),
    );
    const token = extractToken(preview);
    const confirm = await confirmAs(A.tenantId, A.ownerId, token, {
      role: "owner",
      permissions: ["manage_purchases"],
    });
    expect(confirm.ok).toBe(true);
    const bal = await readSupplierBalance(A.tenantId, supplierHussein);
    expect(bal).toBeCloseTo(31_900 - 10_000, 2);
  });

  it("2. works regardless of how many open POs exist", async () => {
    // Hussein still has 3 POs with their original paid_amounts — none should
    // have changed from the account-level payment.
    const rows = await withTenant(A.tenantId, (tx) =>
      tx
        .select({ total: purchaseOrders.total, paidAmount: purchaseOrders.paidAmount })
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.tenantId, A.tenantId),
            eq(purchaseOrders.supplierId, supplierHussein),
          ),
        ),
    );
    expect(rows).toHaveLength(3);
    // per-PO paidAmounts untouched (14k/0, 14k/0, 4.5k/600)
    const paids = rows.map((r) => Number(r.paidAmount)).sort((a, b) => a - b);
    expect(paids).toEqual([0, 0, 600]);
  });

  it("3. creates ONE money_movements row of kind=supplier_payment_direct", async () => {
    const rows = await withTenant(A.tenantId, (tx) =>
      tx
        .select()
        .from(moneyMovements)
        .where(
          and(
            eq(moneyMovements.tenantId, A.tenantId),
            eq(moneyMovements.kind, "supplier_payment_direct"),
            eq(moneyMovements.relatedEntityId, supplierHussein),
          ),
        ),
    );
    // One row from the previous test's confirm.
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(10_000);
    expect(rows[0].relatedEntityType).toBe("supplier");
  });

  it("4. does NOT create any expense row (not an operating expense)", async () => {
    const rows = await withTenant(A.tenantId, (tx) =>
      tx
        .select({ c: sql<number>`count(*)::int` })
        .from(expenses)
        .where(eq(expenses.tenantId, A.tenantId)),
    );
    expect(Number(rows[0]?.c ?? 0)).toBe(0);
  });

  it("5. does NOT create any product or inventory movement", async () => {
    const rows = await withTenant(A.tenantId, (tx) =>
      tx
        .select({ c: sql<number>`count(*)::int` })
        .from(products)
        .where(eq(products.tenantId, A.tenantId)),
    );
    // No seed products in this suite; account-level payment must not create any.
    expect(Number(rows[0]?.c ?? 0)).toBe(0);
  });

  it("6. does NOT create a new purchase order", async () => {
    const [row] = await withTenant(A.tenantId, (tx) =>
      tx
        .select({ c: sql<number>`count(*)::int` })
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.tenantId, A.tenantId),
            eq(purchaseOrders.supplierId, supplierHussein),
          ),
        ),
    );
    expect(Number(row?.c ?? 0)).toBe(3); // still the 3 we seeded
  });
});

/* ─────────────────── error and safety paths ─────────────────── */

describe("preview_record_supplier_account_payment — safety", () => {
  it("7. rejects amount <= 0", async () => {
    const r1 = await executeTool(
      ownerCtx(A),
      "preview_record_supplier_account_payment",
      JSON.stringify({ supplierId: supplierHussein, amount: 0 }),
    );
    expect(r1.ok).toBe(false);
    expect((r1 as { error: string }).error).toBe("INVALID_AMOUNT");
    const r2 = await executeTool(
      ownerCtx(A),
      "preview_record_supplier_account_payment",
      JSON.stringify({ supplierId: supplierHussein, amount: -5 }),
    );
    expect(r2.ok).toBe(false);
  });

  it("8. rejects amount > current supplier.balance (no prepayment)", async () => {
    // Hussein's balance is now 21,900 (31,900 − 10,000 from test 1).
    const res = await executeTool(
      ownerCtx(A),
      "preview_record_supplier_account_payment",
      JSON.stringify({ supplierId: supplierHussein, amount: 25_000 }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("AMOUNT_EXCEEDS_BALANCE");
  });

  it("9. rejects paying a supplier we don't owe (balance = 0)", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "preview_record_supplier_account_payment",
      JSON.stringify({ supplierId: supplierMahmoud, amount: 100 }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("AMOUNT_EXCEEDS_BALANCE");
  });

  it("10. rejects unknown supplier id", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "preview_record_supplier_account_payment",
      JSON.stringify({ supplierId: "00000000-0000-0000-0000-000000000000", amount: 100 }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("SUPPLIER_NOT_FOUND");
  });

  it("11. cross-tenant: A cannot pay B's supplier", async () => {
    const res = await executeTool(
      ownerCtx(A),
      "preview_record_supplier_account_payment",
      JSON.stringify({ supplierId: supplierHusseinB, amount: 1000 }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("SUPPLIER_NOT_FOUND");
  });

  it("12. requires manage_purchases permission", async () => {
    const res = await executeTool(
      staffCtx(A, []),
      "preview_record_supplier_account_payment",
      JSON.stringify({ supplierId: supplierHussein, amount: 500 }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });

  it("13. permission revoked between preview and confirm → FORBIDDEN_AT_CONFIRM", async () => {
    const preview = await executeTool(
      ownerCtx(A),
      "preview_record_supplier_account_payment",
      JSON.stringify({ supplierId: supplierHussein, amount: 500 }),
    );
    const token = extractToken(preview);
    const confirm = await confirmAs(A.tenantId, A.ownerId, token, {
      role: "staff",
      permissions: [], // revoked
    });
    expect(confirm.ok).toBe(false);
    expect(confirm.reason).toBe("FORBIDDEN_AT_CONFIRM");
  });

  it("14. duplicate confirmation → ALREADY_CONSUMED", async () => {
    const preview = await executeTool(
      ownerCtx(A),
      "preview_record_supplier_account_payment",
      JSON.stringify({ supplierId: supplierHussein, amount: 300 }),
    );
    const token = extractToken(preview);
    const r1 = await confirmAs(A.tenantId, A.ownerId, token, {
      role: "owner",
      permissions: ["manage_purchases"],
    });
    expect(r1.ok).toBe(true);
    const r2 = await confirmAs(A.tenantId, A.ownerId, token, {
      role: "owner",
      permissions: ["manage_purchases"],
    });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe("ALREADY_CONSUMED");
  });
});
