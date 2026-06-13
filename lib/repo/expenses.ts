// Expense domain. Split out of operations.ts as part of the SOLID phase 2
// god-module refactor. Existing imports of these from "@/lib/repo/operations"
// still resolve via re-export.

import { and, eq, desc, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { expenses as expensesTable } from "@/lib/db/schema";
import type { Expense, ExpenseCategory } from "@/lib/types";
import { bustInsightsCache } from "@/lib/repo/insights";

function rowToExpense(r: typeof expensesTable.$inferSelect): Expense {
  return {
    id: r.id,
    title: r.title,
    amount: Number(r.amount),
    category: r.category as ExpenseCategory,
    supplierId: r.supplierId ?? null,
    isRecurring: r.isRecurring,
    recurrencePeriod:
      (r.recurrencePeriod as "monthly" | "weekly" | null) ?? null,
    nextOccurrenceDate: r.nextOccurrenceDate ?? null,
    parentExpenseId: r.parentExpenseId ?? null,
    date: r.date,
    note: r.note ?? undefined,
  };
}

/**
 * Spawn child instances for any recurring expense template whose
 * next_occurrence_date has passed, then bump the template's next date forward.
 *
 * Two callers today:
 *   1. `listExpenses` — lazy catch-up when an owner opens /expenses.
 *   2. `/api/cron/recurring-expenses` — periodic sweep so the bill appears
 *      even if no one has visited the page that month.
 *
 * Idempotent: each iteration advances `next_occurrence_date`, so a re-run
 * within the same minute spawns nothing extra.
 */
export async function materializeDueRecurringExpenses(
  tenantId: string,
): Promise<{ spawned: number }> {
  let spawned = 0;
  await withTenant(tenantId, async (tx) => {
    const due = await tx
      .select()
      .from(expensesTable)
      .where(
        and(
          eq(expensesTable.tenantId, tenantId),
          eq(expensesTable.isRecurring, true),
          sql`${expensesTable.nextOccurrenceDate} is not null`,
          sql`${expensesTable.nextOccurrenceDate} <= now()`,
        ),
      );

    for (const tpl of due) {
      let occurrence = tpl.nextOccurrenceDate ?? new Date();
      // Catch up: spawn one child per missed period until we're back in the
      // future. Cap at 12 iterations defensively in case the template was
      // dormant a long time. We batch the rows + the (single) supplier
      // debit so the catch-up costs O(1) writes per template instead of
      // O(periods).
      const childRows: (typeof expensesTable.$inferInsert)[] = [];
      for (let i = 0; i < 12 && occurrence <= new Date(); i += 1) {
        childRows.push({
          tenantId,
          title: tpl.title,
          amount: tpl.amount,
          category: tpl.category,
          supplierId: tpl.supplierId,
          date: occurrence,
          note: tpl.note,
          parentExpenseId: tpl.id,
          isRecurring: false,
        });
        const next = new Date(occurrence);
        if (tpl.recurrencePeriod === "weekly") {
          next.setDate(next.getDate() + 7);
        } else {
          next.setMonth(next.getMonth() + 1);
        }
        occurrence = next;
      }

      if (childRows.length > 0) {
        await tx.insert(expensesTable).values(childRows);
        spawned += childRows.length;
        if (tpl.supplierId) {
          const totalDebit = Number(tpl.amount) * childRows.length;
          await tx.execute(sql`
            update suppliers
            set balance = (balance)::numeric - ${String(totalDebit)}::numeric,
                updated_at = now()
            where tenant_id = ${tenantId} and id = ${tpl.supplierId}
          `);
        }
      }

      await tx
        .update(expensesTable)
        .set({ nextOccurrenceDate: occurrence })
        .where(
          and(
            eq(expensesTable.tenantId, tenantId),
            eq(expensesTable.id, tpl.id),
          ),
        );
    }
  });
  if (spawned > 0) await bustInsightsCache(tenantId);
  return { spawned };
}

export async function listExpenses(
  tenantId: string,
  /** When set, restrict to that branch (excludes tenant-wide null-branch
   *  expenses). Null = every branch + tenant-wide. */
  branchId?: string | null,
): Promise<Expense[]> {
  // Lazy: catch up any due recurring instances before listing.
  await materializeDueRecurringExpenses(tenantId);

  return withTenant(tenantId, async (tx) => {
    const filters = [eq(expensesTable.tenantId, tenantId)];
    if (branchId) filters.push(eq(expensesTable.branchId, branchId));
    const rows = await tx
      .select()
      .from(expensesTable)
      .where(and(...filters))
      .orderBy(desc(expensesTable.date));
    return rows.map(rowToExpense);
  });
}

export interface AddExpenseInput {
  title: string;
  amount: number;
  category: ExpenseCategory;
  supplierId?: string | null;
  isRecurring?: boolean;
  recurrencePeriod?: "monthly" | "weekly" | null;
  date?: Date;
  note?: string;
  /** Branch this expense was incurred at. Null = tenant-wide (e.g. SaaS
   *  subscription, accounting fees) — caller is responsible for the
   *  semantic. */
  branchId?: string | null;
  /** Who recorded the expense. When the branch has cash reconciliation
   *  enabled and the recorder has an open shift, the expense is stamped
   *  with that shift_id so its amount flows into expected_cash. */
  recordedByUserId?: string | null;
  recordedByRole?: "owner" | "staff" | null;
}

export async function addExpense(
  tenantId: string,
  input: AddExpenseInput,
): Promise<{ id: string }> {
  const result = await withTenant(tenantId, async (tx) => {
    const startDate = input.date ?? new Date();
    let nextOccurrenceDate: Date | null = null;
    if (input.isRecurring && input.recurrencePeriod) {
      nextOccurrenceDate = new Date(startDate);
      if (input.recurrencePeriod === "weekly") {
        nextOccurrenceDate.setDate(nextOccurrenceDate.getDate() + 7);
      } else {
        nextOccurrenceDate.setMonth(nextOccurrenceDate.getMonth() + 1);
      }
    }

    const [created] = await tx
      .insert(expensesTable)
      .values({
        tenantId,
        branchId: input.branchId ?? null,
        title: input.title,
        amount: String(input.amount),
        category: input.category,
        supplierId: input.supplierId ?? null,
        isRecurring: !!input.isRecurring,
        recurrencePeriod: input.isRecurring
          ? input.recurrencePeriod ?? "monthly"
          : null,
        nextOccurrenceDate,
        date: startDate,
        note: input.note ?? null,
      })
      .returning({ id: expensesTable.id });

    if (input.supplierId) {
      await tx.execute(sql`
        update suppliers
        set balance = (balance)::numeric - ${input.amount.toFixed(2)}::numeric,
            updated_at = now()
        where tenant_id = ${tenantId} and id = ${input.supplierId}
      `);
    }
    return { id: created.id };
  });
  await bustInsightsCache(tenantId);
  return result;
}

export async function deleteExpense(tenantId: string, id: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select({
        amount: expensesTable.amount,
        supplierId: expensesTable.supplierId,
      })
      .from(expensesTable)
      .where(and(eq(expensesTable.tenantId, tenantId), eq(expensesTable.id, id)))
      .limit(1);

    if (existing?.supplierId) {
      await tx.execute(sql`
        update suppliers
        set balance = (balance)::numeric + ${existing.amount}::numeric,
            updated_at = now()
        where tenant_id = ${tenantId} and id = ${existing.supplierId}
      `);
    }

    await tx
      .delete(expensesTable)
      .where(and(eq(expensesTable.tenantId, tenantId), eq(expensesTable.id, id)));
  });
  await bustInsightsCache(tenantId);
}
