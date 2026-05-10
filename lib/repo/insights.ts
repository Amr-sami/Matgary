import { and, eq, gte, lte, sql } from "drizzle-orm";
import { format } from "date-fns";
import { withTenant } from "@/lib/db";
import {
  sales,
  returns as returnsTable,
  expenses as expensesTable,
  products,
} from "@/lib/db/schema";
import { cacheBustPrefix, cacheRemember, tenantKey } from "@/lib/cache";

// Server-side replacement for the old client `useInsights` aggregation. Every
// figure that used to be computed in the browser is now SQL-aggregated inside
// a `withTenant` transaction, so:
//
//  - The browser stops downloading every sale/return/expense/product row just
//    to compute six numbers — a 50 k-sale tenant used to ship multi-MB JSON.
//  - RLS on the underlying tables guarantees the aggregate is tenant-scoped
//    even if the surrounding code accidentally drops a `tenant_id` filter.
//  - The result is small enough to cache cheaply (per-tenant, per-window) for
//    a minute, blunting hammering of the dashboard.
//
// The `cost of goods` line prefers `sales.cost_price_at_sale` (snapshotted at
// sale time) and falls back to the product's current `cost_price`. The old
// client always used the product's current cost; the snapshot is more correct
// for historical reporting (a cost change today doesn't rewrite last month's
// profit). Legacy rows without a snapshot keep the old behaviour.

const INSIGHTS_TTL_SEC = 60;
const TREND_MAX_DAYS = 90;
const OVERVIEW_PREFIX = "insights:overview";

export interface InsightsWindow {
  from: Date;
  to: Date;
}

/** Sentinel meaning "every branch" — used in the cache key so it doesn't
 *  collide with a real UUID. */
const ALL_BRANCHES_SENTINEL = "all";

export interface InsightsOverview {
  /** Echoes back the resolved window. Null when caller passed no window. */
  window: { from: string; to: string } | null;
  metrics: {
    currentRevenue: number;
    lastRevenue: number;
    revenueGrowth: number;
    totalRevenue: number;
    totalCostOfGoods: number;
    totalExpenses: number;
    grossProfit: number;
    netProfit: number;
    totalDiscounts: number;
    discountPercent: number;
    totalSales: number;
    totalReturns: number;
  };
  trendData: Array<{ date: string; revenue: number; count: number }>;
  topProducts: Array<{
    id: string;
    name: string;
    brand: string | null;
    qty: number;
    revenue: number;
  }>;
  categoryChartData: Array<{ name: string; value: number }>;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

/**
 * Drop every cached overview slice for a tenant. Call from any mutation that
 * could shift one of the underlying numbers (sale, return, expense, product
 * cost change, sale void, etc.).
 */
export async function bustInsightsCache(tenantId: string): Promise<void> {
  await cacheBustPrefix(tenantKey(tenantId, OVERVIEW_PREFIX));
}

/** Load an overview slice. Caller is trusted to be tenant-scoped.
 *  `branchId === null` means "every branch in the tenant". */
export async function loadInsightsOverview(
  tenantId: string,
  window: InsightsWindow | null,
  branchId: string | null,
): Promise<InsightsOverview> {
  // Cache key shape: tenantKey(t, "insights:overview", "<from-ms>", "<to-ms>", "<branch>")
  // — branch is part of the key so an owner viewing "all branches" doesn't
  // see a cached single-branch slice.
  const fromKey = window ? String(window.from.getTime()) : "all";
  const toKey = window ? String(window.to.getTime()) : "all";
  const branchKey = branchId ?? ALL_BRANCHES_SENTINEL;
  return cacheRemember(
    tenantKey(tenantId, OVERVIEW_PREFIX, fromKey, toKey, branchKey),
    INSIGHTS_TTL_SEC,
    () => computeOverview(tenantId, window, branchId),
  );
}

async function computeOverview(
  tenantId: string,
  window: InsightsWindow | null,
  branchId: string | null,
): Promise<InsightsOverview> {
  return withTenant(tenantId, async (tx) => {
    const now = new Date();

    // ── 1. Headline revenue: current vs prior period ───────────────────────
    let curStart: Date;
    let curEnd: Date;
    let prevStart: Date;
    let prevEnd: Date;
    if (window) {
      curStart = window.from;
      curEnd = window.to;
      const lengthMs = curEnd.getTime() - curStart.getTime();
      prevEnd = new Date(curStart.getTime() - 1);
      prevStart = new Date(prevEnd.getTime() - lengthMs);
    } else {
      // No window → preserve the old "this calendar month vs last calendar
      // month" headline so the default page render is unchanged.
      curStart = new Date(now.getFullYear(), now.getMonth(), 1);
      curEnd = endOfDay(now);
      prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      prevEnd = endOfDay(new Date(curStart.getTime() - 1));
    }

    // Money columns are declared as `text` in Drizzle for client-side
    // precision but are actually `numeric` in the DB (an early hand-written
    // migration converted them). That means we work with them directly — no
    // `::numeric` cast, no `nullif(x, '')` (the latter forces coercion of
    // the text literal `''` into `numeric` and trips 22P02). NULL handling
    // is automatic: `sum()` ignores NULL, arithmetic with NULL is NULL.
    const sumRevenue = sql<string>`coalesce(sum(${sales.totalPrice}), 0)::text`;
    // Branch filter is appended to every sales/expenses/returns WHERE so the
    // owner viewing one branch sees only that branch's numbers — including
    // the prior-period comparison and the daily trend.
    const branchSalesFilter = branchId ? eq(sales.branchId, branchId) : undefined;
    const branchReturnsFilter = branchId
      ? eq(sales.branchId, branchId) // returns join sales below; we filter on the joined sale row
      : undefined;

    const [curRow] = await tx
      .select({ total: sumRevenue })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, tenantId),
          gte(sales.saleDate, curStart),
          lte(sales.saleDate, curEnd),
          ...(branchSalesFilter ? [branchSalesFilter] : []),
        ),
      );
    const [prevRow] = await tx
      .select({ total: sumRevenue })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, tenantId),
          gte(sales.saleDate, prevStart),
          lte(sales.saleDate, prevEnd),
          ...(branchSalesFilter ? [branchSalesFilter] : []),
        ),
      );

    const currentRevenue = Number(curRow?.total ?? 0);
    const lastRevenue = Number(prevRow?.total ?? 0);
    const revenueGrowth =
      lastRevenue === 0
        ? currentRevenue > 0
          ? 100
          : 0
        : ((currentRevenue - lastRevenue) / lastRevenue) * 100;

    // ── 2. Window-bounded totals (or all-time when no window) ──────────────
    const winSalesFilters = [eq(sales.tenantId, tenantId)];
    const winExpensesFilters = [eq(expensesTable.tenantId, tenantId)];
    if (window) {
      winSalesFilters.push(
        gte(sales.saleDate, window.from),
        lte(sales.saleDate, window.to),
      );
      winExpensesFilters.push(
        gte(expensesTable.date, window.from),
        lte(expensesTable.date, window.to),
      );
    }
    if (branchSalesFilter) winSalesFilters.push(branchSalesFilter);
    // For expenses, "single branch view" = only expenses attributed to that
    // branch. Tenant-wide expenses (null branchId) are deliberately excluded
    // so the branch P&L is comparable across branches; the owner sees them
    // in the "all branches" view.
    if (branchId) winExpensesFilters.push(eq(expensesTable.branchId, branchId));

    const [salesAgg] = await tx
      .select({
        revenue: sumRevenue,
        cost: sql<string>`coalesce(sum(
          coalesce(${sales.costPriceAtSale}, ${products.costPrice}, 0)
            * ${sales.quantitySold}
        ), 0)::text`,
        discounts: sql<string>`coalesce(sum(coalesce(${sales.discountAmount}, 0)), 0)::text`,
        potential: sql<string>`coalesce(sum(
          coalesce(${sales.subtotal}, ${sales.totalPrice}, 0)
        ), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(sales)
      .leftJoin(products, eq(products.id, sales.productId))
      .where(and(...winSalesFilters));

    // Returns join the parent sale so the branch filter can apply on
    // sales.branch_id (returns themselves don't carry one).
    const returnFilters = [eq(returnsTable.tenantId, tenantId)];
    if (window) {
      returnFilters.push(
        gte(returnsTable.returnDate, window.from),
        lte(returnsTable.returnDate, window.to),
      );
    }
    if (branchReturnsFilter) returnFilters.push(branchReturnsFilter);
    const [returnsAgg] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(returnsTable)
      .innerJoin(sales, eq(sales.id, returnsTable.saleId))
      .where(and(...returnFilters));

    const [expensesAgg] = await tx
      .select({
        total: sql<string>`coalesce(sum(${expensesTable.amount}), 0)::text`,
      })
      .from(expensesTable)
      .where(and(...winExpensesFilters));

    const totalRevenue = Number(salesAgg?.revenue ?? 0);
    const totalCostOfGoods = Number(salesAgg?.cost ?? 0);
    const totalDiscounts = Number(salesAgg?.discounts ?? 0);
    const potentialRevenue = Number(salesAgg?.potential ?? 0);
    const totalSales = Number(salesAgg?.count ?? 0);
    const totalReturns = Number(returnsAgg?.count ?? 0);
    const totalExpenses = Number(expensesAgg?.total ?? 0);
    const grossProfit = totalRevenue - totalCostOfGoods;
    const netProfit = grossProfit - totalExpenses;
    const discountPercent =
      potentialRevenue === 0 ? 0 : (totalDiscounts / potentialRevenue) * 100;

    // ── 3. Top 5 products by quantity sold ─────────────────────────────────
    const topProductRows = await tx
      .select({
        id: sales.productId,
        name: sales.productName,
        brand: sales.brand,
        qty: sql<number>`sum(${sales.quantitySold})::int`,
        revenue: sumRevenue,
      })
      .from(sales)
      .where(and(...winSalesFilters))
      .groupBy(sales.productId, sales.productName, sales.brand)
      .orderBy(sql`sum(${sales.quantitySold}) desc`)
      .limit(5);

    // ── 4. Category breakdown (revenue per category) ───────────────────────
    const categoryRows = await tx
      .select({
        category: sales.categoryId,
        revenue: sumRevenue,
      })
      .from(sales)
      .where(and(...winSalesFilters))
      .groupBy(sales.categoryId);

    // ── 5. Daily trend, capped at TREND_MAX_DAYS ───────────────────────────
    let trendStart: Date;
    let trendEnd: Date;
    if (window) {
      trendStart = startOfDay(window.from);
      trendEnd = endOfDay(window.to);
    } else {
      trendEnd = endOfDay(now);
      const t = startOfDay(now);
      t.setDate(t.getDate() - 29);
      trendStart = t;
    }
    const totalDays =
      Math.floor(
        (trendEnd.getTime() - trendStart.getTime()) / (24 * 60 * 60 * 1000),
      ) + 1;
    const cappedStart =
      totalDays > TREND_MAX_DAYS
        ? new Date(
            trendEnd.getTime() - (TREND_MAX_DAYS - 1) * 24 * 60 * 60 * 1000,
          )
        : trendStart;

    const trendRows = await tx
      .select({
        bucket: sql<Date>`date_trunc('day', ${sales.saleDate})`,
        revenue: sumRevenue,
        count: sql<number>`count(*)::int`,
      })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, tenantId),
          gte(sales.saleDate, cappedStart),
          lte(sales.saleDate, trendEnd),
          ...(branchSalesFilter ? [branchSalesFilter] : []),
        ),
      )
      .groupBy(sql`date_trunc('day', ${sales.saleDate})`)
      .orderBy(sql`date_trunc('day', ${sales.saleDate})`);

    // Zero-fill missing days so the chart x-axis is continuous.
    const byDay = new Map<string, { revenue: number; count: number }>();
    for (const r of trendRows) {
      const day = startOfDay(new Date(r.bucket as unknown as string));
      byDay.set(day.toISOString(), {
        revenue: Number(r.revenue ?? 0),
        count: Number(r.count ?? 0),
      });
    }
    const trendData: InsightsOverview["trendData"] = [];
    const cursor = startOfDay(cappedStart);
    const lastDay = startOfDay(trendEnd);
    while (cursor.getTime() <= lastDay.getTime()) {
      const hit = byDay.get(cursor.toISOString());
      trendData.push({
        date: format(cursor, "MMM dd"),
        revenue: hit?.revenue ?? 0,
        count: hit?.count ?? 0,
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    return {
      window: window
        ? { from: window.from.toISOString(), to: window.to.toISOString() }
        : null,
      metrics: {
        currentRevenue,
        lastRevenue,
        revenueGrowth,
        totalRevenue,
        totalCostOfGoods,
        totalExpenses,
        grossProfit,
        netProfit,
        totalDiscounts,
        discountPercent,
        totalSales,
        totalReturns,
      },
      trendData,
      topProducts: topProductRows.map((r) => ({
        id: r.id,
        name: r.name,
        brand: r.brand ?? null,
        qty: Number(r.qty ?? 0),
        revenue: Number(r.revenue ?? 0),
      })),
      categoryChartData: categoryRows.map((r) => ({
        name: r.category,
        value: Number(r.revenue ?? 0),
      })),
    };
  });
}
