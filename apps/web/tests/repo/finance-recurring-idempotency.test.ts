// Final slice — recurring-expense generator idempotency.
//
// The existing helper `materializeDueRecurringExpenses` is reused through
// the new /api/financials/recurring/generate route. This test proves that
// repeated invocations produce exactly one child per due period, not N — the
// non-negotiable rule from §11 of the final brief.
//
// Two guard rails back that up:
//   1. The helper's `next_occurrence_date` is advanced inside the same
//      transaction it writes the child, so a re-run sees nothing due.
//   2. Migration 0064 added a partial UNIQUE index on
//      (tenant_id, parent_expense_id, date) WHERE parent_expense_id IS NOT NULL
//      — a defence-in-depth guard at the DB layer should the app-level logic
//      ever regress.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  branches,
  expenses as expensesTable,
  shopSettings,
  tenants,
  tenantMembers,
  users,
} from "@/lib/db/schema";
import { materializeDueRecurringExpenses } from "@/lib/repo/expenses";

let tenant: { tenantId: string; userId: string; branchId: string };

async function freshTenant() {
  return db.transaction(async (tx) => {
    const email = `rec-${Date.now()}@test.local`;
    const [u] = await tx
      .insert(users)
      .values({ email, name: "Rec", passwordHash: "x" })
      .returning({ id: users.id });
    const [t] = await tx
      .insert(tenants)
      .values({
        name: "Rec",
        slug: `rec-${Math.random().toString(36).slice(2, 8)}`,
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
      shopName: "Rec",
    });
    return { tenantId: t.id, userId: u.id, branchId: b.id };
  });
}

beforeAll(async () => {
  tenant = await freshTenant();
});

afterAll(async () => {
  if (tenant?.tenantId)
    await db.execute(sql`delete from tenants where id = ${tenant.tenantId}`);
});

/** Insert a recurring template whose `nextOccurrenceDate` is already due. */
async function insertDueTemplate(opts: {
  title: string;
  amount: number;
  dueAt: Date;
  period: "weekly" | "monthly";
}): Promise<string> {
  return withTenant(tenant.tenantId, async (tx) => {
    const [row] = await tx
      .insert(expensesTable)
      .values({
        tenantId: tenant.tenantId,
        title: opts.title,
        amount: String(opts.amount),
        category: "rent",
        isRecurring: true,
        recurrencePeriod: opts.period,
        nextOccurrenceDate: opts.dueAt,
        date: opts.dueAt,
      })
      .returning({ id: expensesTable.id });
    return row.id;
  });
}

async function countChildrenOf(templateId: string): Promise<number> {
  const rows = await withTenant(tenant.tenantId, (tx) =>
    tx
      .select({ id: expensesTable.id })
      .from(expensesTable)
      .where(
        and(
          eq(expensesTable.tenantId, tenant.tenantId),
          eq(expensesTable.parentExpenseId, templateId),
        ),
      ),
  );
  return rows.length;
}

describe("Recurring expense generator — idempotency", () => {
  it("first run spawns the overdue child(ren)", async () => {
    // 1 monthly template, next_occurrence_date = 30 days ago → one child due.
    const dueAt = new Date();
    dueAt.setDate(dueAt.getDate() - 30);
    const tplId = await insertDueTemplate({
      title: "Internet",
      amount: 500,
      dueAt,
      period: "monthly",
    });

    const r = await materializeDueRecurringExpenses(tenant.tenantId);
    expect(r.spawned).toBeGreaterThan(0);
    expect(await countChildrenOf(tplId)).toBe(r.spawned);
  });

  it("second run immediately after spawns ZERO additional rows", async () => {
    const tplId = await insertDueTemplate({
      title: "Hosting",
      amount: 200,
      dueAt: new Date(Date.now() - 60 * 60 * 1000), // one hour ago
      period: "monthly",
    });

    const r1 = await materializeDueRecurringExpenses(tenant.tenantId);
    const count1 = await countChildrenOf(tplId);
    expect(count1).toBeGreaterThan(0);

    const r2 = await materializeDueRecurringExpenses(tenant.tenantId);
    const count2 = await countChildrenOf(tplId);
    // The run returns the *total* spawned across every template; what we're
    // asserting is that THIS template didn't gain any children.
    void r1;
    void r2;
    expect(count2).toBe(count1);
  });

  it("templates that aren't due produce nothing even on repeated runs", async () => {
    // next_occurrence_date in the future → no spawn.
    const future = new Date();
    future.setDate(future.getDate() + 10);
    const tplId = await insertDueTemplate({
      title: "Future rent",
      amount: 9_000,
      dueAt: future,
      period: "monthly",
    });

    await materializeDueRecurringExpenses(tenant.tenantId);
    await materializeDueRecurringExpenses(tenant.tenantId);
    expect(await countChildrenOf(tplId)).toBe(0);
  });

  it("DB-level unique index refuses a duplicate child for the same (template, date)", async () => {
    // Manually try to insert two rows with identical (template, date). The
    // partial UNIQUE index created in migration 0064 must refuse the second.
    const tplId = await insertDueTemplate({
      title: "Weekly cleaning",
      amount: 150,
      dueAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      period: "weekly",
    });

    const sameDate = new Date();
    await withTenant(tenant.tenantId, (tx) =>
      tx.insert(expensesTable).values({
        tenantId: tenant.tenantId,
        title: "Weekly cleaning",
        amount: "150",
        category: "other",
        date: sameDate,
        parentExpenseId: tplId,
        isRecurring: false,
      }),
    );

    // Second insert with the same (tenant, parent, date) must throw.
    await expect(
      withTenant(tenant.tenantId, (tx) =>
        tx.insert(expensesTable).values({
          tenantId: tenant.tenantId,
          title: "Weekly cleaning (dup)",
          amount: "150",
          category: "other",
          date: sameDate,
          parentExpenseId: tplId,
          isRecurring: false,
        }),
      ),
    ).rejects.toBeTruthy();
  });
});
