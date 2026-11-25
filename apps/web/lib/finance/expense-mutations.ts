// Slice 2b.1 — Financials expense CRUD.
//
// Writes go to the existing `expenses` table (same source of truth that the
// legacy `/api/expenses` routes still read/write, and that the P&L engine
// aggregates). What's new here:
//
//   • `status` lifecycle: new rows ship as 'posted'; void flips to 'voided'
//     without a hard delete so audit history survives (Slice 1 schema).
//   • `category_id` FK into `financial_categories` is the source of truth
//     for how the row rolls up in the P&L hierarchy. The legacy flat
//     `category` text column is also written so pre-migration code paths
//     that still read it continue working.
//   • `payment_method`, `reference_number`, `created_by_user_id` are
//     captured on every write.
//
// No branch awareness anywhere. New rows omit the legacy FK column so
// Postgres fills NULL (the column has no default and is nullable).

import "server-only";

import { and, eq, gte, lte, sql, desc, asc, or, ilike, inArray } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  expenses as expensesTable,
  financialCategories,
  payrollPeriods,
} from "@/lib/db/schema";

/** Parent id of the system "People" category group. Finalized payroll
 *  already captures every monthly labor cost that would otherwise be posted
 *  here as a manual Finance expense — so an expense whose category rolls
 *  up under People is a double-count unless the payroll month is not yet
 *  finalized. Hard-coded because the row is seeded in 0064_financials.sql
 *  with that stable UUID and there's exactly one People group per instance. */
const PEOPLE_GROUP_ID = "00000000-0000-4001-0000-000000000001";

export interface FinanceExpenseListFilters {
  from?: Date;
  to?: Date;
  /** Match on `category_id` directly OR on any of its subcategories when the
   *  caller passes a group id (we expand group → child ids at query time). */
  categoryId?: string;
  paymentMethod?: string;
  /** 'posted' | 'voided' | 'any' (default 'posted'). */
  status?: "posted" | "voided" | "any";
  minAmount?: number;
  maxAmount?: number;
  /** Case-insensitive substring match on title / reference_number / note. */
  search?: string;
  limit?: number;
  /** Cursor keyset = `${isoDate}:${id}`. */
  cursor?: string | null;
}

export interface FinanceExpenseRow {
  id: string;
  title: string;
  amount: number;
  date: string;
  categoryId: string | null;
  categorySlug: string | null;
  categoryNameEn: string | null;
  categoryNameAr: string | null;
  categoryGroupSlug: string | null;
  paymentMethod: string | null;
  referenceNumber: string | null;
  note: string | null;
  supplierId: string | null;
  status: "posted" | "voided";
  voidedAt: string | null;
  voidReason: string | null;
  createdByUserId: string | null;
  isRecurringTemplate: boolean;
  parentExpenseId: string | null;
}

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

/**
 * List financial expenses for the tenant, with server-side filtering and
 * keyset pagination on `(date desc, id desc)` — same pagination convention
 * as the existing sales history.
 */
export async function listFinanceExpenses(
  tenantId: string,
  filters: FinanceExpenseListFilters = {},
): Promise<{ data: FinanceExpenseRow[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(filters.limit ?? PAGE_DEFAULT, PAGE_MAX));
  const status = filters.status ?? "posted";

  return withTenant(tenantId, async (tx) => {
    const where = [eq(expensesTable.tenantId, tenantId)];

    if (status !== "any") where.push(eq(expensesTable.status, status));
    if (filters.from) where.push(gte(expensesTable.date, filters.from));
    if (filters.to) where.push(lte(expensesTable.date, filters.to));

    // Category id can point at a GROUP or a LEAF. For a group, expand to
    // all its direct children (the schema is two levels deep).
    if (filters.categoryId) {
      const childRows = await tx
        .select({ id: financialCategories.id })
        .from(financialCategories)
        .where(eq(financialCategories.parentId, filters.categoryId));
      const ids = [filters.categoryId, ...childRows.map((r) => r.id)];
      where.push(inArray(expensesTable.categoryId, ids));
    }

    if (filters.paymentMethod) {
      where.push(eq(expensesTable.paymentMethod, filters.paymentMethod));
    }

    if (filters.minAmount !== undefined) {
      where.push(sql`${expensesTable.amount}::numeric >= ${String(filters.minAmount)}::numeric`);
    }
    if (filters.maxAmount !== undefined) {
      where.push(sql`${expensesTable.amount}::numeric <= ${String(filters.maxAmount)}::numeric`);
    }

    if (filters.search && filters.search.trim()) {
      const q = `%${filters.search.trim()}%`;
      where.push(
        or(
          ilike(expensesTable.title, q),
          ilike(expensesTable.referenceNumber, q),
          ilike(expensesTable.note, q),
        )!,
      );
    }

    // Keyset: `${ISO}:${uuid}`
    if (filters.cursor) {
      const idx = filters.cursor.lastIndexOf(":");
      if (idx > 0) {
        const dateStr = filters.cursor.slice(0, idx);
        const cursorId = filters.cursor.slice(idx + 1);
        const cursorDate = new Date(dateStr);
        if (!Number.isNaN(cursorDate.getTime())) {
          // (date, id) strictly less than cursor.
          where.push(
            sql`(${expensesTable.date}, ${expensesTable.id}) < (${cursorDate.toISOString()}::timestamptz, ${cursorId}::uuid)`,
          );
        }
      }
    }

    const rows = await tx
      .select({
        id: expensesTable.id,
        title: expensesTable.title,
        amount: expensesTable.amount,
        date: expensesTable.date,
        categoryId: expensesTable.categoryId,
        categorySlug: financialCategories.slug,
        categoryNameEn: financialCategories.nameEn,
        categoryNameAr: financialCategories.nameAr,
        categoryGroupSlug: sql<string | null>`(
          select p.slug from financial_categories p
          where p.id = ${financialCategories.parentId}
        )`,
        paymentMethod: expensesTable.paymentMethod,
        referenceNumber: expensesTable.referenceNumber,
        note: expensesTable.note,
        supplierId: expensesTable.supplierId,
        status: expensesTable.status,
        voidedAt: expensesTable.voidedAt,
        voidReason: expensesTable.voidReason,
        createdByUserId: expensesTable.createdByUserId,
        isRecurring: expensesTable.isRecurring,
        parentExpenseId: expensesTable.parentExpenseId,
      })
      .from(expensesTable)
      .leftJoin(
        financialCategories,
        eq(financialCategories.id, expensesTable.categoryId),
      )
      .where(and(...where))
      .orderBy(desc(expensesTable.date), desc(expensesTable.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
      ? `${page[page.length - 1].date.toISOString()}:${page[page.length - 1].id}`
      : null;

    return {
      data: page.map((r) => ({
        id: r.id,
        title: r.title,
        amount: Number(r.amount),
        date: r.date.toISOString(),
        categoryId: r.categoryId,
        categorySlug: r.categorySlug,
        categoryNameEn: r.categoryNameEn,
        categoryNameAr: r.categoryNameAr,
        categoryGroupSlug: r.categoryGroupSlug,
        paymentMethod: r.paymentMethod,
        referenceNumber: r.referenceNumber,
        note: r.note,
        supplierId: r.supplierId,
        status: r.status as "posted" | "voided",
        voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
        voidReason: r.voidReason,
        createdByUserId: r.createdByUserId,
        isRecurringTemplate: r.isRecurring,
        parentExpenseId: r.parentExpenseId,
      })),
      nextCursor,
    };
  });
}

export interface CreateFinanceExpenseInput {
  title: string;
  amount: number;
  date: Date;
  categoryId: string;
  paymentMethod?: string | null;
  referenceNumber?: string | null;
  note?: string | null;
  supplierId?: string | null;
  createdByUserId: string;
}

/**
 * Creates a posted expense. Writes to BOTH the new `category_id` FK and the
 * legacy `category` text column so pre-migration code paths continue to read
 * sane values.
 *
 * Throws `CategoryNotFoundError` if `categoryId` doesn't resolve to a visible
 * (system OR tenant-own, non-archived) financial category.
 */
export class CategoryNotFoundError extends Error {
  constructor() {
    super("CATEGORY_NOT_FOUND");
    this.name = "CategoryNotFoundError";
  }
}

/** Thrown when a manual expense under the People group would double-count
 *  a month that already has a finalized payroll sheet. See `PEOPLE_GROUP_ID`
 *  for the rationale. Carries the offending month so the UI can jump the
 *  Owner straight to the payroll register. */
export class PayrollDoubleCountError extends Error {
  constructor(public readonly periodStart: Date, public readonly categorySlug: string) {
    super("PAYROLL_DOUBLE_COUNT");
    this.name = "PayrollDoubleCountError";
  }
}

export async function createFinanceExpense(
  tenantId: string,
  input: CreateFinanceExpenseInput,
): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    const [cat] = await tx
      .select({
        slug: financialCategories.slug,
        parentId: financialCategories.parentId,
      })
      .from(financialCategories)
      .where(
        and(
          eq(financialCategories.id, input.categoryId),
          sql`${financialCategories.archivedAt} is null`,
          // Must be visible to this tenant: system (tenant_id null) or own.
          or(
            sql`${financialCategories.tenantId} is null`,
            eq(financialCategories.tenantId, tenantId),
          )!,
        ),
      )
      .limit(1);
    if (!cat) throw new CategoryNotFoundError();

    // Double-count guard: any category rolling up under People is already
    // captured by the payroll sheet for that month. Reject the manual post
    // so the P&L doesn't show the same cost twice.
    if (cat.parentId === PEOPLE_GROUP_ID || input.categoryId === PEOPLE_GROUP_ID) {
      const periodStart = firstOfMonthUtc(input.date);
      const [finalized] = await tx
        .select({ id: payrollPeriods.id })
        .from(payrollPeriods)
        .where(
          and(
            eq(payrollPeriods.tenantId, tenantId),
            eq(payrollPeriods.periodStart, periodStart),
            eq(payrollPeriods.status, "finalized"),
          ),
        )
        .limit(1);
      if (finalized) {
        throw new PayrollDoubleCountError(periodStart, cat.slug);
      }
    }

    const [created] = await tx
      .insert(expensesTable)
      .values({
        tenantId,
        title: input.title,
        amount: String(input.amount),
        // Legacy enum: preserved for back-compat with rows written pre-0064.
        // The slug is always a safe value because we validated the category
        // above; if the slug isn't in the legacy enum list we fall back to
        // 'other' rather than violate the CHECK constraint.
        category: legacyCategoryFromSlug(cat.slug),
        categoryId: input.categoryId,
        paymentMethod: input.paymentMethod ?? null,
        referenceNumber: input.referenceNumber ?? null,
        note: input.note ?? null,
        supplierId: input.supplierId ?? null,
        createdByUserId: input.createdByUserId,
        status: "posted",
        date: input.date,
      })
      .returning({ id: expensesTable.id });

    return { id: created.id };
  });
}

function firstOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * Patch a subset of fields on a posted expense. Only `title / amount / date
 * / categoryId / paymentMethod / referenceNumber / note / supplierId` are
 * editable — status + void fields + lifecycle timestamps are not.
 *
 * Returns `null` if the row doesn't exist or is already voided (voided rows
 * are immutable; the caller should un-void them first if that's ever a
 * feature — for Slice 2b.1 it isn't).
 */
export async function updateFinanceExpense(
  tenantId: string,
  id: string,
  patch: {
    title?: string;
    amount?: number;
    date?: Date;
    categoryId?: string;
    paymentMethod?: string | null;
    referenceNumber?: string | null;
    note?: string | null;
    supplierId?: string | null;
  },
): Promise<{ ok: true } | { ok: false; reason: "NOT_FOUND" | "VOIDED" | "CATEGORY_NOT_FOUND" }> {
  return withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select({ status: expensesTable.status })
      .from(expensesTable)
      .where(and(eq(expensesTable.tenantId, tenantId), eq(expensesTable.id, id)))
      .limit(1);
    if (!existing) return { ok: false, reason: "NOT_FOUND" } as const;
    if (existing.status === "voided") return { ok: false, reason: "VOIDED" } as const;

    // Resolve new category (and its legacy enum) when it changes.
    let legacyCategory: string | undefined;
    if (patch.categoryId) {
      const [cat] = await tx
        .select({ slug: financialCategories.slug })
        .from(financialCategories)
        .where(
          and(
            eq(financialCategories.id, patch.categoryId),
            sql`${financialCategories.archivedAt} is null`,
            or(
              sql`${financialCategories.tenantId} is null`,
              eq(financialCategories.tenantId, tenantId),
            )!,
          ),
        )
        .limit(1);
      if (!cat) return { ok: false, reason: "CATEGORY_NOT_FOUND" } as const;
      legacyCategory = legacyCategoryFromSlug(cat.slug);
    }

    const updates: Record<string, unknown> = {};
    if (patch.title !== undefined) updates.title = patch.title;
    if (patch.amount !== undefined) updates.amount = String(patch.amount);
    if (patch.date !== undefined) updates.date = patch.date;
    if (patch.categoryId !== undefined) {
      updates.categoryId = patch.categoryId;
      updates.category = legacyCategory;
    }
    if (patch.paymentMethod !== undefined) updates.paymentMethod = patch.paymentMethod;
    if (patch.referenceNumber !== undefined) updates.referenceNumber = patch.referenceNumber;
    if (patch.note !== undefined) updates.note = patch.note;
    if (patch.supplierId !== undefined) updates.supplierId = patch.supplierId;

    if (Object.keys(updates).length === 0) return { ok: true } as const; // nothing to do

    await tx
      .update(expensesTable)
      .set(updates)
      .where(and(eq(expensesTable.tenantId, tenantId), eq(expensesTable.id, id)));

    return { ok: true };
  });
}

/**
 * Flip the expense to `voided`. Preserves the row and its amount; the P&L
 * engine excludes voided rows at query time (see `fetchPnLSource` in
 * lib/finance/pnl.ts).
 */
export async function voidFinanceExpense(
  tenantId: string,
  id: string,
  opts: { voidedByUserId: string; reason?: string | null },
): Promise<{ ok: true } | { ok: false; reason: "NOT_FOUND" | "ALREADY_VOIDED" }> {
  return withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select({ status: expensesTable.status })
      .from(expensesTable)
      .where(and(eq(expensesTable.tenantId, tenantId), eq(expensesTable.id, id)))
      .limit(1);
    if (!existing) return { ok: false, reason: "NOT_FOUND" } as const;
    if (existing.status === "voided") return { ok: false, reason: "ALREADY_VOIDED" } as const;

    await tx
      .update(expensesTable)
      .set({
        status: "voided",
        voidedAt: new Date(),
        voidedByUserId: opts.voidedByUserId,
        voidReason: opts.reason ?? null,
      })
      .where(and(eq(expensesTable.tenantId, tenantId), eq(expensesTable.id, id)));

    return { ok: true };
  });
}

// Satisfy the legacy `expenses.category` CHECK / text constraint. The slug
// coming from financial_categories is a free-form string; the legacy column
// only accepts a small enum. Map everything else to 'other'.
function legacyCategoryFromSlug(slug: string): string {
  switch (slug) {
    case "rent":
    case "salaries":
    case "electricity":
    case "water":
    case "internet":
      return slug;
    default:
      return "other";
  }
}

// `asc` is imported but currently unused — keep the import to signal
// we may add ascending sort as a filter option in Slice 2b.2.
void asc;
