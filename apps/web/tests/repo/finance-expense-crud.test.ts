// Slice 2b.1 — integration tests for the Financials expense CRUD mutations.
// Hits real Postgres via `withTenant`. Non-destructive: creates isolated
// tenants, tears them down in afterAll via CASCADE on `tenants.id`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  branches,
  expenses as expensesTable,
  financialCategories,
  shopSettings,
  tenants,
  tenantMembers,
  users,
} from "@/lib/db/schema";
import {
  CategoryNotFoundError,
  createFinanceExpense,
  listFinanceExpenses,
  updateFinanceExpense,
  voidFinanceExpense,
} from "@/lib/finance/expense-mutations";
import { computePnLFromSource, fetchPnLSource } from "@/lib/finance/pnl";

let tenantA: { tenantId: string; userId: string; branchId: string };
let tenantB: { tenantId: string; userId: string; branchId: string };

// Seeded system category ids from migration 0064 (rent + salaries +
// electricity are stable UUIDs we can trust).
const CAT_RENT = "00000000-0000-4012-0000-000000000001";
const CAT_SALARIES = "00000000-0000-4011-0000-000000000001";
const CAT_ELECTRICITY = "00000000-0000-4013-0000-000000000001";

async function freshTenant(suffix: string) {
  return db.transaction(async (tx) => {
    const email = `fin-crud-${suffix}-${Date.now()}@test.local`;
    const [u] = await tx
      .insert(users)
      .values({ email, name: `Crud ${suffix}`, passwordHash: "x" })
      .returning({ id: users.id });
    const slug = `fin-crud-${suffix}-${Math.random().toString(36).slice(2, 8)}`;
    const [t] = await tx
      .insert(tenants)
      .values({ name: `Crud ${suffix}`, slug })
      .returning({ id: tenants.id });
    await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
    const [b] = await tx
      .insert(branches)
      .values({
        tenantId: t.id,
        slug: "main",
        name: "Main",
        isPrimary: true,
      })
      .returning({ id: branches.id });
    await tx.insert(tenantMembers).values({
      tenantId: t.id,
      userId: u.id,
      role: "owner",
    });
    await tx.insert(shopSettings).values({
      tenantId: t.id,
      branchId: b.id,
      shopName: `Crud ${suffix}`,
    });
    return { tenantId: t.id, userId: u.id, branchId: b.id };
  });
}

async function cleanup(id: string) {
  await db.execute(sql`delete from tenants where id = ${id}`);
}

beforeAll(async () => {
  tenantA = await freshTenant("a");
  tenantB = await freshTenant("b");
});

afterAll(async () => {
  if (tenantA?.tenantId) await cleanup(tenantA.tenantId);
  if (tenantB?.tenantId) await cleanup(tenantB.tenantId);
});

describe("Financials expense CRUD — integration", () => {
  it("creates an expense with the new fields + marks it posted", async () => {
    const { id } = await createFinanceExpense(tenantA.tenantId, {
      title: "September rent",
      amount: 7_500,
      date: new Date("2026-06-15T09:00:00.000Z"),
      categoryId: CAT_RENT,
      paymentMethod: "cash",
      referenceNumber: "LEASE-2026-06",
      note: "Paid landlord in person",
      createdByUserId: tenantA.userId,
    });
    expect(id).toBeTruthy();

    const row = await withTenant(tenantA.tenantId, async (tx) => {
      const [r] = await tx
        .select()
        .from(expensesTable)
        .where(eq(expensesTable.id, id))
        .limit(1);
      return r;
    });
    expect(row).toBeDefined();
    expect(row?.status).toBe("posted");
    expect(Number(row?.amount)).toBe(7_500);
    expect(row?.categoryId).toBe(CAT_RENT);
    expect(row?.paymentMethod).toBe("cash");
    expect(row?.referenceNumber).toBe("LEASE-2026-06");
    expect(row?.createdByUserId).toBe(tenantA.userId);
    // Legacy enum column is also populated so pre-migration code still reads sane.
    expect(row?.category).toBe("rent");
  });

  it("rejects create with an unknown category", async () => {
    await expect(
      createFinanceExpense(tenantA.tenantId, {
        title: "Phantom",
        amount: 100,
        date: new Date("2026-06-15T09:00:00.000Z"),
        categoryId: "00000000-0000-0000-0000-000000000000",
        createdByUserId: tenantA.userId,
      }),
    ).rejects.toBeInstanceOf(CategoryNotFoundError);
  });

  it("list returns the created expenses in newest-first order", async () => {
    await createFinanceExpense(tenantA.tenantId, {
      title: "Electricity",
      amount: 450,
      date: new Date("2026-06-20T09:00:00.000Z"),
      categoryId: CAT_ELECTRICITY,
      paymentMethod: "instapay",
      createdByUserId: tenantA.userId,
    });

    const page = await listFinanceExpenses(tenantA.tenantId, {
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(page.data.length).toBeGreaterThanOrEqual(2);
    expect(page.data[0]!.title).toBe("Electricity");
    expect(page.data[0]!.date > page.data[1]!.date).toBe(true);
    expect(page.data.every((r) => r.status === "posted")).toBe(true);
  });

  it("list filters by categoryId (leaf) and by category group", async () => {
    // Leaf filter.
    const rentOnly = await listFinanceExpenses(tenantA.tenantId, {
      categoryId: CAT_RENT,
    });
    expect(rentOnly.data.length).toBeGreaterThan(0);
    expect(rentOnly.data.every((r) => r.categoryId === CAT_RENT)).toBe(true);

    // Group filter — Rent & Facilities group id.
    const groupRentFac = "00000000-0000-4001-0000-000000000002";
    const groupRows = await listFinanceExpenses(tenantA.tenantId, {
      categoryId: groupRentFac,
    });
    // Every rent-only row is included in the group result.
    for (const r of rentOnly.data) {
      expect(groupRows.data.some((g) => g.id === r.id)).toBe(true);
    }
  });

  it("list supports keyset pagination", async () => {
    const page1 = await listFinanceExpenses(tenantA.tenantId, { limit: 1 });
    expect(page1.data).toHaveLength(1);
    if (!page1.nextCursor) {
      // Only one expense — nothing to paginate past.
      return;
    }
    const page2 = await listFinanceExpenses(tenantA.tenantId, {
      limit: 1,
      cursor: page1.nextCursor,
    });
    expect(page2.data).toHaveLength(1);
    expect(page2.data[0]!.id).not.toBe(page1.data[0]!.id);
  });

  it("updateFinanceExpense patches allowed fields and rejects empty patch via the route layer", async () => {
    const { id } = await createFinanceExpense(tenantA.tenantId, {
      title: "Marketing",
      amount: 1_000,
      date: new Date("2026-06-18T09:00:00.000Z"),
      categoryId: CAT_SALARIES, // intentionally wrong to test edit
      createdByUserId: tenantA.userId,
    });
    const r = await updateFinanceExpense(tenantA.tenantId, id, {
      title: "Facebook ads",
      amount: 1_250,
      categoryId: "00000000-0000-4014-0000-000000000001", // meta_ads
    });
    expect(r.ok).toBe(true);
    const row = await withTenant(tenantA.tenantId, async (tx) =>
      tx
        .select({
          title: expensesTable.title,
          amount: expensesTable.amount,
          categoryId: expensesTable.categoryId,
          category: expensesTable.category,
        })
        .from(expensesTable)
        .where(eq(expensesTable.id, id))
        .then((rows) => rows[0]),
    );
    expect(row?.title).toBe("Facebook ads");
    expect(Number(row?.amount)).toBe(1_250);
    expect(row?.categoryId).toBe("00000000-0000-4014-0000-000000000001");
    // meta_ads isn't in the legacy enum → falls back to 'other'.
    expect(row?.category).toBe("other");
  });

  it("voidFinanceExpense flips status and excludes the row from P&L", async () => {
    const date = new Date("2026-06-25T10:00:00.000Z");
    const { id } = await createFinanceExpense(tenantA.tenantId, {
      title: "Office supplies",
      amount: 300,
      date,
      categoryId: CAT_RENT,
      createdByUserId: tenantA.userId,
    });

    // Before void: appears in P&L.
    const beforeSource = await fetchPnLSource(tenantA.tenantId, {
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-07-01T00:00:00.000Z"),
    });
    const beforeIds = beforeSource.expenses.map((e) => e.expenseId);
    expect(beforeIds).toContain(id);

    const r = await voidFinanceExpense(tenantA.tenantId, id, {
      voidedByUserId: tenantA.userId,
      reason: "Duplicate entry",
    });
    expect(r.ok).toBe(true);

    // After void: NOT in P&L (engine's status filter excludes voided).
    const afterSource = await fetchPnLSource(tenantA.tenantId, {
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-07-01T00:00:00.000Z"),
    });
    const afterIds = afterSource.expenses.map((e) => e.expenseId);
    expect(afterIds).not.toContain(id);

    // Row is still present with status=voided (soft, not hard-delete).
    const row = await withTenant(tenantA.tenantId, async (tx) =>
      tx
        .select({
          status: expensesTable.status,
          voidedAt: expensesTable.voidedAt,
          voidReason: expensesTable.voidReason,
        })
        .from(expensesTable)
        .where(eq(expensesTable.id, id))
        .then((rows) => rows[0]),
    );
    expect(row?.status).toBe("voided");
    expect(row?.voidedAt).toBeTruthy();
    expect(row?.voidReason).toBe("Duplicate entry");
  });

  it("void is idempotency-safe — second void returns ALREADY_VOIDED", async () => {
    const { id } = await createFinanceExpense(tenantA.tenantId, {
      title: "Internet",
      amount: 500,
      date: new Date("2026-06-28T09:00:00.000Z"),
      categoryId: "00000000-0000-4013-0000-000000000004", // internet
      createdByUserId: tenantA.userId,
    });
    const r1 = await voidFinanceExpense(tenantA.tenantId, id, {
      voidedByUserId: tenantA.userId,
    });
    expect(r1.ok).toBe(true);
    const r2 = await voidFinanceExpense(tenantA.tenantId, id, {
      voidedByUserId: tenantA.userId,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("ALREADY_VOIDED");
  });

  it("voided expenses cannot be edited", async () => {
    const { id } = await createFinanceExpense(tenantA.tenantId, {
      title: "Water",
      amount: 80,
      date: new Date("2026-06-29T09:00:00.000Z"),
      categoryId: "00000000-0000-4013-0000-000000000002", // water
      createdByUserId: tenantA.userId,
    });
    await voidFinanceExpense(tenantA.tenantId, id, {
      voidedByUserId: tenantA.userId,
    });
    const r = await updateFinanceExpense(tenantA.tenantId, id, { amount: 90 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("VOIDED");
  });

  it("tenant isolation: list/edit/void for tenant B cannot see tenant A's expenses", async () => {
    const { id } = await createFinanceExpense(tenantA.tenantId, {
      title: "A-only",
      amount: 42,
      date: new Date("2026-06-30T09:00:00.000Z"),
      categoryId: CAT_RENT,
      createdByUserId: tenantA.userId,
    });
    const bPage = await listFinanceExpenses(tenantB.tenantId, {});
    expect(bPage.data.some((r) => r.id === id)).toBe(false);

    const bUpdate = await updateFinanceExpense(tenantB.tenantId, id, {
      amount: 999,
    });
    expect(bUpdate.ok).toBe(false);
    if (!bUpdate.ok) expect(bUpdate.reason).toBe("NOT_FOUND");

    const bVoid = await voidFinanceExpense(tenantB.tenantId, id, {
      voidedByUserId: tenantB.userId,
    });
    expect(bVoid.ok).toBe(false);
    if (!bVoid.ok) expect(bVoid.reason).toBe("NOT_FOUND");

    // A's expense is unchanged.
    const stillThere = await listFinanceExpenses(tenantA.tenantId, {}).then(
      (p) => p.data.find((r) => r.id === id),
    );
    expect(stillThere?.amount).toBe(42);
    expect(stillThere?.status).toBe("posted");
  });
});
