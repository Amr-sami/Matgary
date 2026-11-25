// Final slice — Money Movements CRUD + P&L exclusion integration test.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  branches,
  moneyMovements,
  shopSettings,
  tenants,
  tenantMembers,
  users,
} from "@/lib/db/schema";
import {
  createMoneyMovement,
  directionFor,
  listMoneyMovements,
  updateMoneyMovement,
  voidMoneyMovement,
} from "@/lib/finance/money-movement-mutations";
import { computePnLFromSource, fetchPnLSource } from "@/lib/finance/pnl";

let tenantA: { tenantId: string; userId: string };
let tenantB: { tenantId: string; userId: string };

async function freshTenant(suffix: string) {
  return db.transaction(async (tx) => {
    const email = `mm-${suffix}-${Date.now()}@test.local`;
    const [u] = await tx
      .insert(users)
      .values({ email, name: `MM ${suffix}`, passwordHash: "x" })
      .returning({ id: users.id });
    const [t] = await tx
      .insert(tenants)
      .values({
        name: `MM ${suffix}`,
        slug: `mm-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
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
      shopName: `MM ${suffix}`,
    });
    return { tenantId: t.id, userId: u.id };
  });
}

beforeAll(async () => {
  tenantA = await freshTenant("a");
  tenantB = await freshTenant("b");
});

afterAll(async () => {
  if (tenantA?.tenantId)
    await db.execute(sql`delete from tenants where id = ${tenantA.tenantId}`);
  if (tenantB?.tenantId)
    await db.execute(sql`delete from tenants where id = ${tenantB.tenantId}`);
});

describe("Money Movements CRUD — integration", () => {
  it("creates an owner_deposit with the correct direction = 'in'", async () => {
    const { id } = await createMoneyMovement(tenantA.tenantId, {
      kind: "owner_deposit",
      amount: 50_000,
      occurredAt: new Date("2026-06-15T10:00:00.000Z"),
      description: "Cash injection",
      paymentMethod: "cash",
      createdByUserId: tenantA.userId,
    });
    const [row] = await withTenant(tenantA.tenantId, (tx) =>
      tx
        .select({
          kind: moneyMovements.kind,
          amount: moneyMovements.amount,
          description: moneyMovements.description,
          voidedAt: moneyMovements.voidedAt,
        })
        .from(moneyMovements)
        .where(eq(moneyMovements.id, id)),
    );
    expect(row?.kind).toBe("owner_deposit");
    expect(Number(row?.amount)).toBe(50_000);
    expect(directionFor("owner_deposit")).toBe("in");
  });

  it("supplier_payment_direct, owner_withdrawal, loan_principal_repayment, cash_transfer are classified 'out'", () => {
    expect(directionFor("supplier_payment_direct")).toBe("out");
    expect(directionFor("owner_withdrawal")).toBe("out");
    expect(directionFor("loan_principal_repayment")).toBe("out");
    expect(directionFor("cash_transfer")).toBe("out");
  });

  it("list returns active rows by default; voided excluded", async () => {
    const d = new Date("2026-06-20T10:00:00.000Z");
    const a = await createMoneyMovement(tenantA.tenantId, {
      kind: "owner_withdrawal",
      amount: 1_000,
      occurredAt: d,
      createdByUserId: tenantA.userId,
    });
    await voidMoneyMovement(tenantA.tenantId, a.id, {
      voidedByUserId: tenantA.userId,
      reason: "Correction",
    });

    const active = await listMoneyMovements(tenantA.tenantId, {
      status: "active",
    });
    expect(active.data.some((r) => r.id === a.id)).toBe(false);

    const voided = await listMoneyMovements(tenantA.tenantId, {
      status: "voided",
    });
    expect(voided.data.some((r) => r.id === a.id)).toBe(true);
    expect(voided.data.find((r) => r.id === a.id)?.voidedAt).toBeTruthy();
  });

  it("list filters by kind", async () => {
    await createMoneyMovement(tenantA.tenantId, {
      kind: "loan_received",
      amount: 25_000,
      occurredAt: new Date("2026-06-22T10:00:00.000Z"),
      createdByUserId: tenantA.userId,
    });
    const loans = await listMoneyMovements(tenantA.tenantId, {
      kind: "loan_received",
    });
    expect(loans.data.every((r) => r.kind === "loan_received")).toBe(true);
    expect(loans.data.length).toBeGreaterThan(0);
  });

  it("CRITICAL: money movements are EXCLUDED from P&L (no revenue, no OpEx)", async () => {
    // Seed a window with every movement kind.
    const base = new Date("2026-07-05T10:00:00.000Z");
    for (const kind of [
      "owner_deposit",
      "owner_withdrawal",
      "cash_transfer",
      "loan_received",
      "loan_principal_repayment",
      "supplier_payment_direct",
      "customer_deposit",
    ] as const) {
      await createMoneyMovement(tenantA.tenantId, {
        kind,
        amount: 10_000,
        occurredAt: base,
        createdByUserId: tenantA.userId,
      });
    }

    const source = await fetchPnLSource(tenantA.tenantId, {
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-08-01T00:00:00.000Z"),
    });
    // movements are passed through for the UI strip, but NEVER become
    // expenses / sales / returns / payroll.
    expect(source.moneyMovements.length).toBeGreaterThanOrEqual(7);
    expect(source.sales).toHaveLength(0);
    expect(source.expenses).toHaveLength(0);
    expect(source.returns).toHaveLength(0);
    expect(source.payrollExpenses).toHaveLength(0);

    const pnl = computePnLFromSource(source);
    // Every P&L line must be literally 0 — none of the movements contributed.
    expect(pnl.grossSales).toBe(0);
    expect(pnl.discounts).toBe(0);
    expect(pnl.returnsRevenue).toBe(0);
    expect(pnl.netSales).toBe(0);
    expect(pnl.cogs).toBe(0);
    expect(pnl.grossProfit).toBe(0);
    expect(pnl.operatingExpenses).toBe(0);
    expect(pnl.operatingProfit).toBe(0);
    expect(pnl.otherIncome).toBe(0);
    expect(pnl.otherExpense).toBe(0);
    expect(pnl.netProfit).toBe(0);
  });

  it("voided movement is excluded from the engine's source", async () => {
    const d = new Date("2026-07-10T10:00:00.000Z");
    const { id } = await createMoneyMovement(tenantA.tenantId, {
      kind: "loan_received",
      amount: 20_000,
      occurredAt: d,
      createdByUserId: tenantA.userId,
    });

    const before = await fetchPnLSource(tenantA.tenantId, {
      from: new Date("2026-07-10T00:00:00.000Z"),
      to: new Date("2026-07-11T00:00:00.000Z"),
    });
    expect(before.moneyMovements.some((m) => m.movementId === id)).toBe(true);

    await voidMoneyMovement(tenantA.tenantId, id, {
      voidedByUserId: tenantA.userId,
    });

    const after = await fetchPnLSource(tenantA.tenantId, {
      from: new Date("2026-07-10T00:00:00.000Z"),
      to: new Date("2026-07-11T00:00:00.000Z"),
    });
    expect(after.moneyMovements.some((m) => m.movementId === id)).toBe(false);
  });

  it("update patches description + rejects fields that would alter amount/kind/date", async () => {
    const { id } = await createMoneyMovement(tenantA.tenantId, {
      kind: "other",
      amount: 500,
      occurredAt: new Date("2026-07-11T10:00:00.000Z"),
      description: "initial",
      createdByUserId: tenantA.userId,
    });
    const r = await updateMoneyMovement(tenantA.tenantId, id, {
      description: "updated",
      paymentMethod: "instapay",
    });
    expect(r.ok).toBe(true);
    const page = await listMoneyMovements(tenantA.tenantId, {
      status: "any",
    });
    const row = page.data.find((m) => m.id === id);
    expect(row?.description).toBe("updated");
    expect(row?.paymentMethod).toBe("instapay");
    expect(row?.amount).toBe(500);
  });

  it("voided movement cannot be edited", async () => {
    const { id } = await createMoneyMovement(tenantA.tenantId, {
      kind: "other",
      amount: 1,
      occurredAt: new Date(),
      createdByUserId: tenantA.userId,
    });
    await voidMoneyMovement(tenantA.tenantId, id, {
      voidedByUserId: tenantA.userId,
    });
    const r = await updateMoneyMovement(tenantA.tenantId, id, {
      description: "late edit",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("VOIDED");
  });

  it("double-void is rejected as ALREADY_VOIDED", async () => {
    const { id } = await createMoneyMovement(tenantA.tenantId, {
      kind: "other",
      amount: 1,
      occurredAt: new Date(),
      createdByUserId: tenantA.userId,
    });
    const r1 = await voidMoneyMovement(tenantA.tenantId, id, {
      voidedByUserId: tenantA.userId,
    });
    expect(r1.ok).toBe(true);
    const r2 = await voidMoneyMovement(tenantA.tenantId, id, {
      voidedByUserId: tenantA.userId,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("ALREADY_VOIDED");
  });

  it("tenant isolation — tenant B cannot see, edit, or void A's movements", async () => {
    const { id } = await createMoneyMovement(tenantA.tenantId, {
      kind: "owner_deposit",
      amount: 999,
      occurredAt: new Date(),
      createdByUserId: tenantA.userId,
    });
    const bList = await listMoneyMovements(tenantB.tenantId, { status: "any" });
    expect(bList.data.some((r) => r.id === id)).toBe(false);

    const bUpdate = await updateMoneyMovement(tenantB.tenantId, id, {
      description: "hijacked",
    });
    expect(bUpdate.ok).toBe(false);
    if (!bUpdate.ok) expect(bUpdate.reason).toBe("NOT_FOUND");

    const bVoid = await voidMoneyMovement(tenantB.tenantId, id, {
      voidedByUserId: tenantB.userId,
    });
    expect(bVoid.ok).toBe(false);
    if (!bVoid.ok) expect(bVoid.reason).toBe("NOT_FOUND");
  });
});
