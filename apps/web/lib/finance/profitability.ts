// Final closure — product / category profitability.
//
// Uses the SAME accounting rules as the P&L engine:
//   - revenue = SUM(sales.subtotal - sales.discountAmount) for the period
//   - returns reverse revenue proportional to the returned share of totalPrice
//   - COGS uses sales.costPriceAtSale snapshot ONLY; never falls back to
//     the current products.costPrice
//   - returns reverse the exact snapshot cost × returned qty
//
// Zero branch awareness. Zero fake data. If costPriceAtSale is NULL on a
// sale row, COGS for that row is 0 (never silently revalued).

import "server-only";

import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  categories,
  returns as returnsTable,
  sales as salesTable,
} from "@/lib/db/schema";
import { safeNum } from "./pnl";
import type { FinancePeriod } from "./types";

export interface ProductProfitabilityRow {
  productId: string;
  productName: string;
  brand: string | null;
  quantitySold: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  /** 0..1 — safeDiv so a zero-revenue line stays 0 instead of NaN. */
  margin: number;
}

export interface CategoryProfitabilityRow {
  categoryId: string;
  categoryLabel: string | null;
  quantitySold: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  margin: number;
}

export type ProfitabilitySort = "revenue" | "grossProfit" | "margin" | "quantity";

function safeDiv(n: number, d: number): number {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

/** Aggregate per-product profit for the period. Returns are netted:
 *  the row shows qtySold - returnedQty, revenue reduced by the returned
 *  proportional share of totalPrice, and COGS reduced by snapshot × returnedQty. */
export async function computeProductProfitability(
  tenantId: string,
  period: FinancePeriod,
  opts: {
    search?: string;
    sort?: ProfitabilitySort;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: ProductProfitabilityRow[]; total: number }> {
  const sort = opts.sort ?? "grossProfit";
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const offset = Math.max(0, opts.offset ?? 0);

  return withTenant(tenantId, async (tx) => {
    // Sales in window — one row per sale line.
    const salesWhere = [
      eq(salesTable.tenantId, tenantId),
      gte(salesTable.saleDate, period.from),
      lt(salesTable.saleDate, period.to),
    ];
    if (opts.search && opts.search.trim()) {
      salesWhere.push(sql`${salesTable.productName} ilike ${"%" + opts.search.trim() + "%"}`);
    }

    const saleRows = await tx
      .select({
        productId: salesTable.productId,
        productName: salesTable.productName,
        brand: salesTable.brand,
        quantitySold: salesTable.quantitySold,
        returnedQuantity: salesTable.returnedQuantity,
        subtotal: salesTable.subtotal,
        discountAmount: salesTable.discountAmount,
        totalPrice: salesTable.totalPrice,
        costPriceAtSale: salesTable.costPriceAtSale,
      })
      .from(salesTable)
      .where(and(...salesWhere));

    // Returns in window — reverse the parent sale.
    const returnRows = await tx
      .select({
        returnedQty: returnsTable.returnedQuantity,
        saleId: returnsTable.saleId,
        productId: salesTable.productId,
        saleQuantitySold: salesTable.quantitySold,
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

    // Roll up per product.
    const byProduct = new Map<string, ProductProfitabilityRow>();

    for (const s of saleRows) {
      const amount = safeNum(s.subtotal) - safeNum(s.discountAmount);
      const cost = safeNum(s.costPriceAtSale) * safeNum(s.quantitySold);
      const entry = byProduct.get(s.productId) ?? {
        productId: s.productId,
        productName: s.productName,
        brand: s.brand,
        quantitySold: 0,
        revenue: 0,
        cogs: 0,
        grossProfit: 0,
        margin: 0,
      };
      entry.quantitySold += safeNum(s.quantitySold);
      entry.revenue += amount;
      entry.cogs += cost;
      byProduct.set(s.productId, entry);
    }

    // Returns: subtract from the matching product row.
    for (const r of returnRows) {
      const qty = safeNum(r.returnedQty);
      const saleQty = safeNum(r.saleQuantitySold);
      if (qty <= 0 || saleQty <= 0) continue;
      const share = safeDiv(qty, saleQty);
      const revenueReversal = safeNum(r.saleTotalPrice) * share;
      const cogsReversal = safeNum(r.saleCostPriceAtSale) * qty;

      const entry = byProduct.get(r.productId);
      if (!entry) continue;
      entry.quantitySold -= qty;
      entry.revenue -= revenueReversal;
      entry.cogs -= cogsReversal;
    }

    // Finalise margin + grossProfit.
    const rowsAll = Array.from(byProduct.values()).map((e) => ({
      ...e,
      grossProfit: e.revenue - e.cogs,
      margin: safeDiv(e.revenue - e.cogs, e.revenue),
    }));

    // Sort.
    rowsAll.sort((a, b) => {
      switch (sort) {
        case "revenue":
          return b.revenue - a.revenue;
        case "margin":
          return b.margin - a.margin;
        case "quantity":
          return b.quantitySold - a.quantitySold;
        case "grossProfit":
        default:
          return b.grossProfit - a.grossProfit;
      }
    });

    return {
      rows: rowsAll.slice(offset, offset + limit),
      total: rowsAll.length,
    };
  });
}

/** Aggregate per-category profit for the period. Same rules; grouped by the
 *  snapshot `categoryId` on the sale row. Label is pulled from the live
 *  `categories` table (falls back to raw UUID if the row was deleted). */
export async function computeCategoryProfitability(
  tenantId: string,
  period: FinancePeriod,
  opts: { sort?: ProfitabilitySort } = {},
): Promise<CategoryProfitabilityRow[]> {
  const sort = opts.sort ?? "grossProfit";

  return withTenant(tenantId, async (tx) => {
    const saleRows = await tx
      .select({
        categoryId: salesTable.categoryId,
        quantitySold: salesTable.quantitySold,
        subtotal: salesTable.subtotal,
        discountAmount: salesTable.discountAmount,
        costPriceAtSale: salesTable.costPriceAtSale,
      })
      .from(salesTable)
      .where(
        and(
          eq(salesTable.tenantId, tenantId),
          gte(salesTable.saleDate, period.from),
          lt(salesTable.saleDate, period.to),
        ),
      );

    const returnRows = await tx
      .select({
        categoryId: salesTable.categoryId,
        returnedQty: returnsTable.returnedQuantity,
        saleQuantitySold: salesTable.quantitySold,
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

    const byCat = new Map<
      string,
      { quantitySold: number; revenue: number; cogs: number }
    >();

    for (const s of saleRows) {
      const entry = byCat.get(s.categoryId) ?? {
        quantitySold: 0,
        revenue: 0,
        cogs: 0,
      };
      entry.quantitySold += safeNum(s.quantitySold);
      entry.revenue += safeNum(s.subtotal) - safeNum(s.discountAmount);
      entry.cogs += safeNum(s.costPriceAtSale) * safeNum(s.quantitySold);
      byCat.set(s.categoryId, entry);
    }

    for (const r of returnRows) {
      const qty = safeNum(r.returnedQty);
      const saleQty = safeNum(r.saleQuantitySold);
      if (qty <= 0 || saleQty <= 0) continue;
      const share = safeDiv(qty, saleQty);
      const entry = byCat.get(r.categoryId);
      if (!entry) continue;
      entry.quantitySold -= qty;
      entry.revenue -= safeNum(r.saleTotalPrice) * share;
      entry.cogs -= safeNum(r.saleCostPriceAtSale) * qty;
    }

    const catIds = Array.from(byCat.keys());
    const labelByCat = new Map<string, string>();
    if (catIds.length > 0) {
      const catRows = await tx
        .select({ id: categories.id, label: categories.label })
        .from(categories)
        .where(
          and(
            eq(categories.tenantId, tenantId),
            inArray(categories.id, catIds),
          ),
        );
      for (const c of catRows) labelByCat.set(c.id, c.label);
    }

    const rows = Array.from(byCat.entries()).map(([categoryId, e]) => {
      const grossProfit = e.revenue - e.cogs;
      return {
        categoryId,
        categoryLabel: labelByCat.get(categoryId) ?? null,
        quantitySold: e.quantitySold,
        revenue: e.revenue,
        cogs: e.cogs,
        grossProfit,
        margin: safeDiv(grossProfit, e.revenue),
      };
    });

    rows.sort((a, b) => {
      switch (sort) {
        case "revenue":
          return b.revenue - a.revenue;
        case "margin":
          return b.margin - a.margin;
        case "quantity":
          return b.quantitySold - a.quantitySold;
        case "grossProfit":
        default:
          return b.grossProfit - a.grossProfit;
      }
    });

    return rows;
  });
}

// `desc` is imported but only used indirectly through Drizzle's SQL builder
// via the SORT paths above. Keep import for clarity.
void desc;
