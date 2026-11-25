// Slice 1 — deterministic P&L calculation engine.
//
// Split into two layers so every scenario in the test suite can run against
// in-memory data without needing a Postgres fixture:
//
//   1. `computePnLFromSource(source)`  — pure function. No side effects, no
//      DB, no imports from Drizzle. Tests use this directly.
//   2. `fetchPnLSource(tx, …)`         — loads the rows the engine needs,
//      constrained to the tenant and the period.
//   3. `computePnL(tenantId, from, to)` — the composed convenience used by
//      the API routes.
//
// Known-bug fixes from the discovery audit:
//   (a) Returns NOW reverse both revenue and COGS inside the return's period.
//   (b) COGS uses `costPriceAtSale` ONLY — no silent fallback to current cost.
//   (c) Zero / null / missing inputs always resolve to literal 0 — no NaN.
//   (d) Order-level discount is already pre-allocated across lines by the cart
//       writer (`apps/web/lib/repo/operations.ts:1091`), so Σ discountAmount
//       is the right total — no double-count risk.

import "server-only";

import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
  expenses as expensesTable,
  financialCategories,
  moneyMovements as moneyMovementsTable,
  payrollPeriods,
  returns as returnsTable,
  sales as salesTable,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db";
import type { FinancePeriod, FinancialOverview, PnL, PnLSource } from "./types";

/** `Number(x)` but safe — never returns NaN, Infinity, or -Infinity. */
export function safeNum(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** `n / d` but 0 when `d` is 0 or either is non-finite. */
function safeDiv(n: number, d: number): number {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

/** Kinds that count as "money in" when rendering the movements strip —
 *  they are still NEVER folded into the P&L. */
const MONEY_IN_KINDS = new Set([
  "owner_deposit",
  "loan_received",
  "customer_deposit",
  "other",
]);

/** Kinds that count as "money out" for the same read-only strip. */
const MONEY_OUT_KINDS = new Set([
  "owner_withdrawal",
  "cash_transfer",
  "loan_principal_repayment",
  "supplier_payment_direct",
]);

export function moneyMovementDirection(kind: string): "in" | "out" {
  if (MONEY_OUT_KINDS.has(kind)) return "out";
  if (MONEY_IN_KINDS.has(kind)) return "in";
  // Unknown kinds are treated as 'in' by default, but they'll show up in the
  // movements list and never affect P&L — the engine cares only that they
  // are excluded from revenue/expense.
  return "in";
}

// ─── pure engine ────────────────────────────────────────────────────────────

/**
 * Compute the full P&L from in-memory source data. 100% pure — same input
 * always yields the same output, no I/O.
 */
export function computePnLFromSource(source: PnLSource): PnL {
  // Revenue side — gross, discounts, net.
  let grossSales = 0;
  let discounts = 0;
  for (const s of source.sales) {
    grossSales += safeNum(s.subtotal);
    discounts += safeNum(s.discountAmount);
  }

  // Returns subtract revenue in the return's period. The parent sale was
  // already counted in whatever earlier period it was rung in; the return
  // row is the reversal entry.
  //
  // Revenue reversal per line = (returnedQtyInPeriod / saleQuantitySold) × saleTotalPrice
  //
  // `saleTotalPrice` is post-discount, so this correctly refunds the
  // customer-paid amount (not the pre-discount subtotal).
  let returnsRevenue = 0;
  let cogsReversal = 0;
  for (const r of source.returns) {
    const qty = safeNum(r.returnedQuantityInPeriod);
    const saleQty = safeNum(r.saleQuantitySold);
    if (qty <= 0 || saleQty <= 0) continue;
    const share = safeDiv(qty, saleQty);
    returnsRevenue += safeNum(r.saleTotalPrice) * share;
    // Cost reversal uses the snapshot × returned quantity (not proportional
    // to totalPrice — cost is per-unit, independent of pricing).
    cogsReversal += safeNum(r.saleCostPriceAtSale) * qty;
  }

  const netSales = grossSales - discounts - returnsRevenue;

  // Forward COGS: cost × quantity for every sale line in the period.
  // NEVER falls back to current product cost — if the snapshot is null/0 the
  // engine reports 0 for that line's cost rather than silently revaluing
  // against today's product.costPrice.
  let cogsForward = 0;
  for (const s of source.sales) {
    cogsForward += safeNum(s.costPriceAtSale) * safeNum(s.quantitySold);
  }

  const cogs = cogsForward - cogsReversal;
  const grossProfit = netSales - cogs;

  // ── OpEx by group + flat list ─────────────────────────────────────────────
  // Categories carry three identifiers: slug (subcategory), groupSlug
  // (parent), and kind (opex / other_income / other_expense). Rows without a
  // category still contribute to operating expenses — they roll up under a
  // synthetic 'other_opex / miscellaneous' bucket so the owner sees them.
  const opexGroupMap = new Map<
    string,
    {
      groupSlug: string;
      groupNameEn: string;
      groupNameAr: string;
      total: number;
      categories: Map<string, { sub: PnLSource["expenses"][number]; amount: number }>;
    }
  >();
  let operatingExpenses = 0;
  let otherIncome = 0;
  let otherExpense = 0;

  for (const e of source.expenses) {
    const amt = safeNum(e.amount);
    if (e.categoryKind === "other_income") {
      otherIncome += amt;
      continue;
    }
    if (e.categoryKind === "other_expense") {
      otherExpense += amt;
      continue;
    }
    // Anything else (including unclassified) contributes to OpEx.
    operatingExpenses += amt;

    const groupSlug = e.categoryGroupSlug ?? "other_opex";
    const groupNameEn = SYSTEM_GROUP_LABELS[groupSlug]?.en ?? "Other";
    const groupNameAr = SYSTEM_GROUP_LABELS[groupSlug]?.ar ?? "أخرى";
    let bucket = opexGroupMap.get(groupSlug);
    if (!bucket) {
      bucket = {
        groupSlug,
        groupNameEn,
        groupNameAr,
        total: 0,
        categories: new Map(),
      };
      opexGroupMap.set(groupSlug, bucket);
    }
    bucket.total += amt;

    const subKey = e.categoryId ?? `__unclassified__${groupSlug}`;
    const entry = bucket.categories.get(subKey);
    if (entry) {
      entry.amount += amt;
    } else {
      bucket.categories.set(subKey, { sub: e, amount: amt });
    }
  }

  // Finalised payroll periods are a form of OpEx. They land under People →
  // Salaries so the P&L hierarchy stays intact. The source already excluded
  // draft periods.
  for (const p of source.payrollExpenses) {
    const amt = safeNum(p.amount);
    operatingExpenses += amt;

    const groupSlug = "people";
    let bucket = opexGroupMap.get(groupSlug);
    if (!bucket) {
      bucket = {
        groupSlug,
        groupNameEn: SYSTEM_GROUP_LABELS.people.en,
        groupNameAr: SYSTEM_GROUP_LABELS.people.ar,
        total: 0,
        categories: new Map(),
      };
      opexGroupMap.set(groupSlug, bucket);
    }
    bucket.total += amt;

    const subKey = "__payroll__";
    const entry = bucket.categories.get(subKey);
    if (entry) {
      entry.amount += amt;
    } else {
      bucket.categories.set(subKey, {
        sub: {
          expenseId: p.payrollPeriodId,
          amount: amt,
          categoryId: null,
          categorySlug: "salaries",
          categoryGroupSlug: "people",
          categoryKind: "opex",
          isPayroll: true,
        },
        amount: amt,
      });
    }
  }

  const operatingProfit = grossProfit - operatingExpenses;
  const netProfit = operatingProfit + otherIncome - otherExpense;

  // Flatten group map → the API shape.
  const operatingExpensesByGroup = Array.from(opexGroupMap.values())
    .map((g) => ({
      groupSlug: g.groupSlug,
      groupNameEn: g.groupNameEn,
      groupNameAr: g.groupNameAr,
      total: g.total,
      categories: Array.from(g.categories.values())
        .map((c) => ({
          categoryId: c.sub.categoryId,
          slug: c.sub.categorySlug,
          nameEn: c.sub.categorySlug ?? "Uncategorised",
          nameAr: c.sub.categorySlug ?? "غير مصنّف",
          groupSlug: g.groupSlug,
          groupNameEn: g.groupNameEn,
          groupNameAr: g.groupNameAr,
          amount: c.amount,
          share: safeDiv(c.amount, operatingExpenses),
        }))
        .sort((a, b) => b.amount - a.amount),
    }))
    .sort((a, b) => b.total - a.total);

  const operatingExpensesByCategory = operatingExpensesByGroup
    .flatMap((g) => g.categories)
    .sort((a, b) => b.amount - a.amount);

  const grossMargin = safeDiv(grossProfit, netSales);
  const netMargin = safeDiv(netProfit, netSales);

  return {
    grossSales,
    discounts,
    returnsRevenue,
    netSales,
    cogs,
    grossProfit,
    operatingExpenses,
    operatingExpensesByGroup,
    operatingExpensesByCategory,
    operatingProfit,
    otherIncome,
    otherExpense,
    netProfit,
    netMargin,
    grossMargin,
  };
}

// Group label lookup for rendering. The engine never translates names; this
// is a safe fallback when an expense's category group is a system seed.
const SYSTEM_GROUP_LABELS: Record<string, { en: string; ar: string }> = {
  people:          { en: "People",             ar: "الموظفون" },
  rent_facilities: { en: "Rent & Facilities",  ar: "الإيجار والمرافق" },
  utilities:       { en: "Utilities",          ar: "المرافق الخدمية" },
  marketing:       { en: "Marketing",          ar: "التسويق" },
  logistics:       { en: "Logistics",          ar: "الخدمات اللوجستية" },
  technology:      { en: "Technology",         ar: "التقنية" },
  professional:    { en: "Professional",       ar: "الخدمات المهنية" },
  financial:       { en: "Financial",          ar: "المصاريف المالية" },
  other_opex:      { en: "Other",              ar: "أخرى" },
};

// ─── DB-touching layer ──────────────────────────────────────────────────────

/**
 * Load the raw rows the engine needs for a (tenant, period) pair. One
 * round-trip per concern — five queries total, all tenant-scoped, all
 * date-range-indexed. Nothing is loaded that the engine doesn't need.
 */
export async function fetchPnLSource(
  tenantId: string,
  period: FinancePeriod,
): Promise<PnLSource> {
  return withTenant(tenantId, async (tx) => {
    // Sales in the period — only columns the engine reads.
    const salesRows = await tx
      .select({
        saleId: salesTable.id,
        quantitySold: salesTable.quantitySold,
        returnedQuantity: salesTable.returnedQuantity,
        pricePerUnit: salesTable.pricePerUnit,
        subtotal: salesTable.subtotal,
        discountAmount: salesTable.discountAmount,
        costPriceAtSale: salesTable.costPriceAtSale,
        totalPrice: salesTable.totalPrice,
      })
      .from(salesTable)
      .where(
        and(
          eq(salesTable.tenantId, tenantId),
          gte(salesTable.saleDate, period.from),
          lt(salesTable.saleDate, period.to),
        ),
      );

    // Returns in the period, joined to the parent sale for cost/price
    // snapshots. The join is INNER because a return without a sale is
    // impossible (FK). Note: the PARENT sale may be older than the period.
    const returnRows = await tx
      .select({
        returnId: returnsTable.id,
        saleId: returnsTable.saleId,
        returnedQuantityInPeriod: returnsTable.returnedQuantity,
        saleQuantitySold: salesTable.quantitySold,
        salePricePerUnit: salesTable.pricePerUnit,
        saleTotalPrice: salesTable.totalPrice,
        saleCostPriceAtSale: salesTable.costPriceAtSale,
      })
      .from(returnsTable)
      .innerJoin(salesTable, eq(salesTable.id, returnsTable.saleId))
      .where(
        and(
          eq(returnsTable.tenantId, tenantId),
          gte(returnsTable.returnDate, period.from),
          lt(returnsTable.returnDate, period.to),
        ),
      );

    // Posted expenses in the period, joined to the category tree so the
    // engine can roll them up by group without a second lookup. LEFT JOIN
    // because rows written before migration 0064 have categoryId=NULL.
    const parentCategories = financialCategories;
    const subCategories = financialCategories;
    const expenseRows = await tx
      .select({
        expenseId: expensesTable.id,
        amount: expensesTable.amount,
        categoryId: expensesTable.categoryId,
        categorySlug: sql<string | null>`${subCategories.slug}`,
        categoryGroupSlug: sql<string | null>`(
          SELECT parent.slug
          FROM financial_categories parent
          WHERE parent.id = ${subCategories.parentId}
        )`,
        categoryKind: sql<"opex" | "other_income" | "other_expense" | null>`${subCategories.kind}`,
      })
      .from(expensesTable)
      .leftJoin(subCategories, eq(subCategories.id, expensesTable.categoryId))
      .where(
        and(
          eq(expensesTable.tenantId, tenantId),
          eq(expensesTable.status, "posted"),
          gte(expensesTable.date, period.from),
          lt(expensesTable.date, period.to),
        ),
      );

    // Finalised payroll periods whose periodStart lands in the window.
    // (V1 writes periodEnd as the first-of-NEXT-month half-open boundary;
    // pre-V1 rows set it to last-moment-of-month. Using periodStart for the
    // membership test is stable across both conventions.)
    const payrollRows = await tx
      .select({
        payrollPeriodId: payrollPeriods.id,
        grossAmount: payrollPeriods.grossAmount,
        adjustmentsAmount: payrollPeriods.adjustmentsAmount,
      })
      .from(payrollPeriods)
      .where(
        and(
          eq(payrollPeriods.tenantId, tenantId),
          eq(payrollPeriods.status, "finalized"),
          gte(payrollPeriods.periodStart, period.from),
          lt(payrollPeriods.periodStart, period.to),
        ),
      );

    // Money movements in the period — NOT folded into P&L, shown for the
    // owner's awareness only.
    const movementRows = await tx
      .select({
        movementId: moneyMovementsTable.id,
        kind: moneyMovementsTable.kind,
        amount: moneyMovementsTable.amount,
      })
      .from(moneyMovementsTable)
      .where(
        and(
          eq(moneyMovementsTable.tenantId, tenantId),
          gte(moneyMovementsTable.occurredAt, period.from),
          lt(moneyMovementsTable.occurredAt, period.to),
          sql`${moneyMovementsTable.voidedAt} is null`,
        ),
      );

    return {
      sales: salesRows.map((r) => ({
        saleId: r.saleId,
        quantitySold: safeNum(r.quantitySold),
        returnedQuantity: safeNum(r.returnedQuantity),
        pricePerUnit: safeNum(r.pricePerUnit),
        subtotal: safeNum(r.subtotal),
        discountAmount: safeNum(r.discountAmount),
        costPriceAtSale: safeNum(r.costPriceAtSale),
        totalPrice: safeNum(r.totalPrice),
      })),
      returns: returnRows.map((r) => ({
        returnId: r.returnId,
        saleId: r.saleId,
        returnedQuantityInPeriod: safeNum(r.returnedQuantityInPeriod),
        saleQuantitySold: safeNum(r.saleQuantitySold),
        salePricePerUnit: safeNum(r.salePricePerUnit),
        saleTotalPrice: safeNum(r.saleTotalPrice),
        saleCostPriceAtSale: safeNum(r.saleCostPriceAtSale),
      })),
      expenses: expenseRows.map((r) => ({
        expenseId: r.expenseId,
        amount: safeNum(r.amount),
        categoryId: r.categoryId,
        categorySlug: r.categorySlug,
        categoryGroupSlug: r.categoryGroupSlug,
        categoryKind: r.categoryKind,
        isPayroll: false,
      })),
      payrollExpenses: payrollRows.map((r) => ({
        payrollPeriodId: r.payrollPeriodId,
        amount: safeNum(r.grossAmount) + safeNum(r.adjustmentsAmount),
      })),
      moneyMovements: movementRows.map((r) => ({
        movementId: r.movementId,
        kind: r.kind,
        amount: safeNum(r.amount),
        direction: moneyMovementDirection(r.kind),
      })),
    };
  });
}

/** Convenience composer used by the API routes. */
export async function computePnL(
  tenantId: string,
  period: FinancePeriod,
): Promise<PnL> {
  const source = await fetchPnLSource(tenantId, period);
  return computePnLFromSource(source);
}

/** Build the flatter "overview" shape (same numbers, different keys). */
export function overviewFromPnl(
  pnl: PnL,
  period: FinancePeriod,
  salesCount: number,
  returnsCount: number,
  moneyMovements: PnLSource["moneyMovements"],
): FinancialOverview {
  let moneyIn = 0;
  let moneyOut = 0;
  for (const m of moneyMovements) {
    if (m.direction === "in") moneyIn += m.amount;
    else moneyOut += m.amount;
  }
  return {
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
    grossSales: pnl.grossSales,
    discounts: pnl.discounts,
    returnsRevenue: pnl.returnsRevenue,
    netSales: pnl.netSales,
    cogs: pnl.cogs,
    grossProfit: pnl.grossProfit,
    grossMargin: pnl.grossMargin,
    operatingExpenses: pnl.operatingExpenses,
    operatingProfit: pnl.operatingProfit,
    otherIncome: pnl.otherIncome,
    otherExpense: pnl.otherExpense,
    netProfit: pnl.netProfit,
    netMargin: pnl.netMargin,
    salesCount,
    returnsCount,
    moneyIn,
    moneyOut,
  };
}
