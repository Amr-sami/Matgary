// Final closure — time-series trends for the Financials charts.
//
// The chart data is DERIVED from the exact same source rows the P&L engine
// uses. We don't reimplement accounting rules; we group sales / returns /
// expenses by bucket (day, week, or month depending on the window span) and
// run the P&L arithmetic on each bucket.
//
// All numbers come from the server. No React-side math.

import "server-only";

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  expenses as expensesTable,
  payrollPeriods,
  returns as returnsTable,
  sales as salesTable,
} from "@/lib/db/schema";
import { safeNum } from "./pnl";
import type { FinancePeriod } from "./types";

export type TrendBucket = "day" | "week" | "month";

export interface TrendPoint {
  /** ISO date at the START of the bucket (YYYY-MM-DD). */
  date: string;
  revenue: number;
  discounts: number;
  returnsRevenue: number;
  netSales: number;
  cogs: number;
  grossProfit: number;
  operatingExpenses: number;
  operatingProfit: number;
  netProfit: number;
}

/** Pick the right bucket size so a chart doesn't show 365 daily points nor
 *  3 monthly ones. */
export function autoBucketFor(period: FinancePeriod): TrendBucket {
  const days =
    (period.to.getTime() - period.from.getTime()) / (24 * 60 * 60 * 1000);
  if (days <= 62) return "day";
  if (days <= 180) return "week";
  return "month";
}

function bucketKey(date: Date, bucket: TrendBucket): string {
  // UTC bucketing — matches the DB's half-open [from, to) convention. The
  // P&L endpoint already resolves wall-clock → UTC instants via the tenant's
  // reporting timezone upstream (lib/finance/dates.ts); bucketing here does
  // not need another timezone translation.
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  if (bucket === "day") return d.toISOString().slice(0, 10);
  if (bucket === "month") {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
  }
  // week: snap to the ISO week's Monday.
  const day = d.getUTCDay(); // 0 = Sun
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - diffToMonday);
  return monday.toISOString().slice(0, 10);
}

function emptyPoint(date: string): TrendPoint {
  return {
    date,
    revenue: 0,
    discounts: 0,
    returnsRevenue: 0,
    netSales: 0,
    cogs: 0,
    grossProfit: 0,
    operatingExpenses: 0,
    operatingProfit: 0,
    netProfit: 0,
  };
}

/**
 * Build a dense (zero-filled) trend series for the given period.
 */
export async function computeTrend(
  tenantId: string,
  period: FinancePeriod,
  explicitBucket?: TrendBucket,
): Promise<{ bucket: TrendBucket; data: TrendPoint[] }> {
  const bucket = explicitBucket ?? autoBucketFor(period);

  return withTenant(tenantId, async (tx) => {
    const salesRows = await tx
      .select({
        saleDate: salesTable.saleDate,
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
        returnDate: returnsTable.returnDate,
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

    const expenseRows = await tx
      .select({
        date: expensesTable.date,
        amount: expensesTable.amount,
      })
      .from(expensesTable)
      .where(
        and(
          eq(expensesTable.tenantId, tenantId),
          eq(expensesTable.status, "posted"),
          gte(expensesTable.date, period.from),
          lt(expensesTable.date, period.to),
        ),
      );

    const payrollRows = await tx
      .select({
        periodEnd: payrollPeriods.periodEnd,
        gross: payrollPeriods.grossAmount,
        adjustments: payrollPeriods.adjustmentsAmount,
      })
      .from(payrollPeriods)
      .where(
        and(
          eq(payrollPeriods.tenantId, tenantId),
          eq(payrollPeriods.status, "finalized"),
          gte(payrollPeriods.periodEnd, period.from),
          lt(payrollPeriods.periodEnd, period.to),
        ),
      );

    // Build zero-filled buckets across the period so a chart line never breaks.
    const points = new Map<string, TrendPoint>();
    const cursor = new Date(period.from);
    while (cursor < period.to) {
      const key = bucketKey(cursor, bucket);
      if (!points.has(key)) points.set(key, emptyPoint(key));
      // Advance by the smallest unit for density.
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    for (const s of salesRows) {
      const k = bucketKey(s.saleDate, bucket);
      const p = points.get(k) ?? emptyPoint(k);
      p.revenue += safeNum(s.subtotal);
      p.discounts += safeNum(s.discountAmount);
      p.cogs += safeNum(s.costPriceAtSale) * safeNum(s.quantitySold);
      points.set(k, p);
    }

    for (const r of returnRows) {
      const qty = safeNum(r.returnedQty);
      const saleQty = safeNum(r.saleQuantitySold);
      if (qty <= 0 || saleQty <= 0) continue;
      const share = qty / saleQty;
      const k = bucketKey(r.returnDate, bucket);
      const p = points.get(k) ?? emptyPoint(k);
      p.returnsRevenue += safeNum(r.saleTotalPrice) * share;
      p.cogs -= safeNum(r.saleCostPriceAtSale) * qty;
      points.set(k, p);
    }

    for (const e of expenseRows) {
      const k = bucketKey(e.date, bucket);
      const p = points.get(k) ?? emptyPoint(k);
      p.operatingExpenses += safeNum(e.amount);
      points.set(k, p);
    }

    for (const pr of payrollRows) {
      const k = bucketKey(pr.periodEnd, bucket);
      const p = points.get(k) ?? emptyPoint(k);
      p.operatingExpenses += safeNum(pr.gross) + safeNum(pr.adjustments);
      points.set(k, p);
    }

    // Derive the dependent metrics per bucket.
    const data = Array.from(points.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((p) => {
        p.netSales = p.revenue - p.discounts - p.returnsRevenue;
        p.grossProfit = p.netSales - p.cogs;
        p.operatingProfit = p.grossProfit - p.operatingExpenses;
        // other income/expense are not time-bucketed in Slice 2 (rare, use the
        // P&L endpoint for the full statement). Net profit here equals
        // operating profit.
        p.netProfit = p.operatingProfit;
        return p;
      });

    return { bucket, data };
  });
}
