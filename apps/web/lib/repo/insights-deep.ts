import { and, asc, desc, eq, gte, ilike, isNotNull, lte, or, sql } from "drizzle-orm";
import { format } from "date-fns";
import { withTenant } from "@/lib/db";
import { collectionsTenantAdmitted } from "@/lib/collections/flags";
import {
  sales,
  products,
  branches,
} from "@/lib/db/schema";

// Analytics reports beyond the flagship overview. Each function returns a
// small, pre-aggregated payload so the browser never re-does the math.
//
// All aggregation happens inside a single `withTenant` transaction — the RLS
// policy shim guarantees the aggregate is tenant-scoped even if a filter is
// omitted. Branch filters ride on top of the tenant filter.
//
// Money columns are text-backed numerics in Drizzle; use them raw in SQL —
// coalesce inside sum() to preserve NULL semantics without a text→numeric
// coercion trip.

// ─────────────────────────────────────────────────────────────────────────────
// 1) Compare periods — current vs. previous period, aligned by offset day.
// ─────────────────────────────────────────────────────────────────────────────

export interface CompareReport {
  window: { from: string; to: string };
  previousWindow: { from: string; to: string };
  // Each point represents offset i inside the window (0-based). `current` is
  // revenue on day i of the current window, `previous` is revenue on day i
  // of the previous window. Aligning by offset (not by calendar day) lets a
  // 7-day vs 7-day compare show up cleanly on the same x-axis.
  points: Array<{
    dayIndex: number;
    /** Calendar day of the *current* window (YYYY-MM-DD) — clients format it locally. */
    day: string;
    label: string;
    current: number;
    previous: number;
  }>;
  totals: { current: number; previous: number; growth: number };
}

export async function loadCompareReport(
  tenantId: string,
  window: { from: Date; to: Date },
  branchId: string | null,
): Promise<CompareReport> {
  const lengthMs = window.to.getTime() - window.from.getTime();
  const prevEnd = new Date(window.from.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - lengthMs);

  return withTenant(tenantId, async (tx) => {
    const branchFilter = branchId ? eq(sales.branchId, branchId) : undefined;

    // date_trunc('day', sale_date) inside a single query per window keeps the
    // grouping predicate consistent whether the range is 3d or 60d.
    const current = await tx
      .select({
        day: sql<Date>`date_trunc('day', ${sales.saleDate})`,
        revenue: sql<string>`coalesce(sum(${sales.totalPrice}), 0)::text`,
      })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, tenantId),
          gte(sales.saleDate, window.from),
          lte(sales.saleDate, window.to),
          ...(branchFilter ? [branchFilter] : []),
        ),
      )
      .groupBy(sql`date_trunc('day', ${sales.saleDate})`);

    const previous = await tx
      .select({
        day: sql<Date>`date_trunc('day', ${sales.saleDate})`,
        revenue: sql<string>`coalesce(sum(${sales.totalPrice}), 0)::text`,
      })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, tenantId),
          gte(sales.saleDate, prevStart),
          lte(sales.saleDate, prevEnd),
          ...(branchFilter ? [branchFilter] : []),
        ),
      )
      .groupBy(sql`date_trunc('day', ${sales.saleDate})`);

    const currentByDay = indexByDay(current);
    const previousByDay = indexByDay(previous);
    const points: CompareReport["points"] = [];
    const totalDays =
      Math.floor(
        (endOfDay(window.to).getTime() - startOfDay(window.from).getTime()) /
          86_400_000,
      ) + 1;

    let currentTotal = 0;
    let previousTotal = 0;
    for (let i = 0; i < totalDays; i += 1) {
      const curDay = addDays(startOfDay(window.from), i);
      const prevDay = addDays(startOfDay(prevStart), i);
      const cur = currentByDay.get(dayKey(curDay)) ?? 0;
      const prev = previousByDay.get(dayKey(prevDay)) ?? 0;
      currentTotal += cur;
      previousTotal += prev;
      points.push({
        dayIndex: i,
        day: dayKey(curDay),
        label: format(curDay, "MMM dd"),
        current: cur,
        previous: prev,
      });
    }
    const growth =
      previousTotal === 0
        ? currentTotal > 0
          ? 100
          : 0
        : ((currentTotal - previousTotal) / previousTotal) * 100;

    return {
      window: {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
      },
      previousWindow: {
        from: prevStart.toISOString(),
        to: prevEnd.toISOString(),
      },
      points,
      totals: { current: currentTotal, previous: previousTotal, growth },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) Hour × Day-of-week heatmap
// ─────────────────────────────────────────────────────────────────────────────

export interface HeatmapReport {
  window: { from: string; to: string } | null;
  // 7 rows (Sun..Sat) × 24 columns (0..23). Value = revenue in that bucket.
  cells: Array<{ dow: number; hour: number; revenue: number; count: number }>;
  peak: { dow: number; hour: number; revenue: number; count: number } | null;
}

export async function loadHeatmapReport(
  tenantId: string,
  window: { from: Date; to: Date } | null,
  branchId: string | null,
): Promise<HeatmapReport> {
  return withTenant(tenantId, async (tx) => {
    const branchFilter = branchId ? eq(sales.branchId, branchId) : undefined;
    const filters = [eq(sales.tenantId, tenantId)];
    if (window) {
      filters.push(
        gte(sales.saleDate, window.from),
        lte(sales.saleDate, window.to),
      );
    }
    if (branchFilter) filters.push(branchFilter);

    const rows = await tx
      .select({
        dow: sql<number>`extract(dow from ${sales.saleDate})::int`,
        hour: sql<number>`extract(hour from ${sales.saleDate})::int`,
        revenue: sql<string>`coalesce(sum(${sales.totalPrice}), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(sales)
      .where(and(...filters))
      .groupBy(
        sql`extract(dow from ${sales.saleDate})`,
        sql`extract(hour from ${sales.saleDate})`,
      );

    const cells: HeatmapReport["cells"] = rows.map((r) => ({
      dow: Number(r.dow ?? 0),
      hour: Number(r.hour ?? 0),
      revenue: Number(r.revenue ?? 0),
      count: Number(r.count ?? 0),
    }));

    let peak: HeatmapReport["peak"] = null;
    for (const c of cells) {
      if (!peak || c.revenue > peak.revenue) peak = c;
    }

    return {
      window: window
        ? { from: window.from.toISOString(), to: window.to.toISOString() }
        : null,
      cells,
      peak,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) Payment mix — revenue per payment method per day
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentMixReport {
  window: { from: string; to: string } | null;
  methods: string[];
  // One row per day; each row has a `label` + one field per method + a
  // `total` convenience field. Recharts consumes this directly.
  series: Array<Record<string, string | number>>;
  totals: Record<string, number>;
  /** Digital collections split (doc 15 spec 13 §4.11); null when
   *  COLLECTIONS_ENABLED does not admit the tenant (no extra query runs). */
  collections: PaymentCollectionsSplit | null;
}

/** The "digital Z" of the payments report: money by verification state. The
 *  gross series above stays revenue by the method on the line (03 §F); a
 *  rejected-to-debt sale is therefore in the `deferred` bar AND in
 *  `rejectedDebt` here — the split is about collections, the bars about lines
 *  (13 §8 R7). Settlement collections are left out: this report is sales. */
export interface PaymentCollectionsSplit {
  byMethod: Record<
    "instapay" | "wallet",
    { confirmed: number; autoConfirmed: number; pending: number; rejectedDebt: number; rejectedLoss: number }
  >;
  /** Σ over digital invoices in the window of max(0, invoice total − Σ non-void sale parts). */
  cashRemainder: number;
  /** Σ total_price of instapay/wallet lines with collection_status IS NULL (rung while collections were off). */
  unverified: number;
}

const KNOWN_METHODS = ["cash", "instapay", "wallet", "card", "deferred"] as const;

/** EGP number from a numeric's text, rounded to piasters. */
function egp2(v: string | number | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export async function loadPaymentMixReport(
  tenantId: string,
  window: { from: Date; to: Date } | null,
  branchId: string | null,
): Promise<PaymentMixReport> {
  return withTenant(tenantId, async (tx) => {
    const branchFilter = branchId ? eq(sales.branchId, branchId) : undefined;
    const filters = [eq(sales.tenantId, tenantId)];
    if (window) {
      filters.push(
        gte(sales.saleDate, window.from),
        lte(sales.saleDate, window.to),
      );
    }
    if (branchFilter) filters.push(branchFilter);

    const rows = await tx
      .select({
        day: sql<Date>`date_trunc('day', ${sales.saleDate})`,
        // coalesce so historic rows with a NULL payment_method still show
        // up in a distinct "unknown" bucket instead of vanishing.
        method: sql<string>`coalesce(${sales.paymentMethod}, 'unknown')`,
        revenue: sql<string>`coalesce(sum(${sales.totalPrice}), 0)::text`,
      })
      .from(sales)
      .where(and(...filters))
      .groupBy(
        sql`date_trunc('day', ${sales.saleDate})`,
        sales.paymentMethod,
      );

    const daySet = new Set<string>();
    const methodSet = new Set<string>();
    const byDayMethod = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const day = dayKey(new Date(r.day as unknown as string));
      daySet.add(day);
      const method = String(r.method);
      methodSet.add(method);
      let inner = byDayMethod.get(day);
      if (!inner) {
        inner = new Map();
        byDayMethod.set(day, inner);
      }
      inner.set(method, Number(r.revenue ?? 0));
    }

    // Ensure a stable order: known methods first, then any exotic values.
    const methods = [
      ...KNOWN_METHODS.filter((m) => methodSet.has(m)),
      ...Array.from(methodSet).filter(
        (m) => !(KNOWN_METHODS as readonly string[]).includes(m),
      ),
    ];

    const days = Array.from(daySet).sort();
    const series = days.map((day) => {
      const row: Record<string, string | number> = {
        label: format(new Date(day), "MMM dd"),
        day,
      };
      let total = 0;
      for (const m of methods) {
        const v = byDayMethod.get(day)?.get(m) ?? 0;
        row[m] = v;
        total += v;
      }
      row.total = total;
      return row;
    });

    const totals: Record<string, number> = {};
    for (const m of methods) {
      totals[m] = series.reduce((s, r) => s + Number(r[m] ?? 0), 0);
    }

    // Digital collections split (13 §4.11): three queries in the same
    // transaction, same window (rung_at = sale_date, 03 §B.2.2) and branch.
    let collectionsSplit: PaymentCollectionsSplit | null = null;
    if (collectionsTenantAdmitted(tenantId)) {
      const fromIso = window?.from.toISOString() ?? null;
      const toIso = window?.to.toISOString() ?? null;
      const cWindow = fromIso && toIso
        ? sql`AND c.rung_at >= ${fromIso}::timestamptz AND c.rung_at <= ${toIso}::timestamptz`
        : sql``;
      const sWindow = fromIso && toIso
        ? sql`AND s.sale_date >= ${fromIso}::timestamptz AND s.sale_date <= ${toIso}::timestamptz`
        : sql``;
      const cBranch = branchId ? sql`AND c.branch_id = ${branchId}` : sql``;
      const sBranch = branchId ? sql`AND s.branch_id = ${branchId}` : sql``;

      const split = (await tx.execute(sql`
        SELECT c.method,
               COALESCE(sum(c.amount) FILTER (WHERE c.status = 'confirmed'), 0)::text AS confirmed,
               COALESCE(sum(c.amount) FILTER (WHERE c.status = 'auto_confirmed'), 0)::text AS auto_confirmed,
               COALESCE(sum(c.amount) FILTER (WHERE c.status = 'pending'), 0)::text AS pending,
               COALESCE(sum(c.amount) FILTER (WHERE c.status = 'rejected' AND c.reject_outcome = 'debt'), 0)::text AS rejected_debt,
               COALESCE(sum(c.amount) FILTER (WHERE c.status = 'rejected' AND c.reject_outcome = 'loss'), 0)::text AS rejected_loss
          FROM collections c
         WHERE c.tenant_id = ${tenantId} AND c.source_type = 'sale'
           ${cWindow} ${cBranch}
         GROUP BY c.method
      `)) as unknown as Array<{
        method: string;
        confirmed: string;
        auto_confirmed: string;
        pending: string;
        rejected_debt: string;
        rejected_loss: string;
      }>;

      const [cash] = (await tx.execute(sql`
        WITH inv AS (
          SELECT s.invoice_id, sum(s.total_price::numeric) AS total
            FROM sales s
           WHERE s.tenant_id = ${tenantId} AND s.collection_status IS NOT NULL AND s.invoice_id IS NOT NULL
             ${sWindow} ${sBranch}
           GROUP BY s.invoice_id
        )
        SELECT COALESCE(sum(GREATEST(0, inv.total - COALESCE((
                 SELECT sum(c.amount) FROM collections c
                  WHERE c.tenant_id = ${tenantId} AND c.invoice_id = inv.invoice_id
                    AND c.source_type = 'sale' AND c.status <> 'void'), 0))), 0)::text AS remainder
          FROM inv
      `)) as unknown as Array<{ remainder: string }>;

      const [unv] = (await tx.execute(sql`
        SELECT COALESCE(sum(s.total_price::numeric) FILTER (
                 WHERE s.payment_method IN ('instapay', 'wallet') AND s.collection_status IS NULL), 0)::text AS unverified
          FROM sales s
         WHERE s.tenant_id = ${tenantId} ${sWindow} ${sBranch}
      `)) as unknown as Array<{ unverified: string }>;

      const zero = () => ({ confirmed: 0, autoConfirmed: 0, pending: 0, rejectedDebt: 0, rejectedLoss: 0 });
      const byMethod = { instapay: zero(), wallet: zero() };
      for (const r of split) {
        if (r.method !== "instapay" && r.method !== "wallet") continue;
        byMethod[r.method] = {
          confirmed: egp2(r.confirmed),
          autoConfirmed: egp2(r.auto_confirmed),
          pending: egp2(r.pending),
          rejectedDebt: egp2(r.rejected_debt),
          rejectedLoss: egp2(r.rejected_loss),
        };
      }
      collectionsSplit = {
        byMethod,
        cashRemainder: egp2(cash?.remainder),
        unverified: egp2(unv?.unverified),
      };
    }

    return {
      window: window
        ? { from: window.from.toISOString(), to: window.to.toISOString() }
        : null,
      methods,
      series,
      totals,
      collections: collectionsSplit,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) Branch comparison — one row per branch (owner + all-branches only)
// ─────────────────────────────────────────────────────────────────────────────

export interface BranchComparisonRow {
  branchId: string;
  branchName: string;
  revenue: number;
  cost: number;
  grossProfit: number;
  discounts: number;
  transactions: number;
  aov: number;
  margin: number;
}

export interface BranchComparisonReport {
  window: { from: string; to: string } | null;
  rows: BranchComparisonRow[];
}

export async function loadBranchComparison(
  tenantId: string,
  window: { from: Date; to: Date } | null,
): Promise<BranchComparisonReport> {
  return withTenant(tenantId, async (tx) => {
    const filters = [eq(sales.tenantId, tenantId), isNotNull(sales.branchId)];
    if (window) {
      filters.push(
        gte(sales.saleDate, window.from),
        lte(sales.saleDate, window.to),
      );
    }

    const rows = await tx
      .select({
        branchId: sales.branchId,
        branchName: branches.name,
        revenue: sql<string>`coalesce(sum(${sales.totalPrice}), 0)::text`,
        cost: sql<string>`coalesce(sum(
          coalesce(${sales.costPriceAtSale}, ${products.costPrice}, 0)
            * ${sales.quantitySold}
        ), 0)::text`,
        discounts: sql<string>`coalesce(sum(coalesce(${sales.discountAmount}, 0)), 0)::text`,
        transactions: sql<number>`count(*)::int`,
      })
      .from(sales)
      .leftJoin(products, eq(products.id, sales.productId))
      .leftJoin(branches, eq(branches.id, sales.branchId))
      .where(and(...filters))
      .groupBy(sales.branchId, branches.name);

    const out: BranchComparisonRow[] = rows.map((r) => {
      const revenue = Number(r.revenue ?? 0);
      const cost = Number(r.cost ?? 0);
      const transactions = Number(r.transactions ?? 0);
      const grossProfit = revenue - cost;
      const aov = transactions === 0 ? 0 : revenue / transactions;
      const margin = revenue === 0 ? 0 : (grossProfit / revenue) * 100;
      return {
        branchId: String(r.branchId),
        branchName: r.branchName ?? "—",
        revenue,
        cost,
        discounts: Number(r.discounts ?? 0),
        grossProfit,
        transactions,
        aov,
        margin,
      };
    });

    // Sort by revenue desc — the branch pulling the most weight goes first.
    out.sort((a, b) => b.revenue - a.revenue);

    return {
      window: window
        ? { from: window.from.toISOString(), to: window.to.toISOString() }
        : null,
      rows: out,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4a) Brand breakdown — totals per brand + store/online split per brand.
//     Takes the same (window?, branchId?) scope as the per-branch report.
//     `brand` is a free-text snapshot on sales (nullable); NULLs collapse into
//     one "—" bucket so the row list isn't padded with empties.
// ─────────────────────────────────────────────────────────────────────────────

export interface BrandBreakdownRow {
  brand: string;
  revenue: number;
  cost: number;
  discounts: number;
  grossProfit: number;
  /** 0 when revenue is 0, else (grossProfit / revenue) * 100. */
  margin: number;
  unitsSold: number;
  transactions: number;
  /** revenue / transactions, 0 when transactions is 0. */
  aov: number;
  /** Channel split — zero-filled when a channel has no sales for the brand. */
  byChannel: {
    store: { revenue: number; transactions: number };
    online: { revenue: number; transactions: number };
  };
}

export interface BrandBreakdownReport {
  window: { from: string; to: string } | null;
  rows: BrandBreakdownRow[];
  totals: {
    revenue: number;
    cost: number;
    grossProfit: number;
    margin: number;
    transactions: number;
  };
}

export async function loadBrandBreakdown(
  tenantId: string,
  window: { from: Date; to: Date } | null,
  branchId: string | null,
): Promise<BrandBreakdownReport> {
  return withTenant(tenantId, async (tx) => {
    const branchFilter = branchId ? eq(sales.branchId, branchId) : undefined;
    const filters = [eq(sales.tenantId, tenantId)];
    if (window) {
      filters.push(
        gte(sales.saleDate, window.from),
        lte(sales.saleDate, window.to),
      );
    }
    if (branchFilter) filters.push(branchFilter);

    // Totals per brand (NULL brand collapses to one bucket).
    const totalsRows = await tx
      .select({
        brand: sql<string>`coalesce(${sales.brand}, '')`,
        revenue: sql<string>`coalesce(sum(${sales.totalPrice}), 0)::text`,
        cost: sql<string>`coalesce(sum(
          coalesce(${sales.costPriceAtSale}, ${products.costPrice}, 0)
            * ${sales.quantitySold}
        ), 0)::text`,
        discounts: sql<string>`coalesce(sum(coalesce(${sales.discountAmount}, 0)), 0)::text`,
        unitsSold: sql<number>`coalesce(sum(${sales.quantitySold}), 0)::int`,
        transactions: sql<number>`count(*)::int`,
      })
      .from(sales)
      .leftJoin(products, eq(products.id, sales.productId))
      .where(and(...filters))
      .groupBy(sql`coalesce(${sales.brand}, '')`);

    // Channel split per brand (store | online). Same filters as above so
    // the two aggregates roll up to identical top-line revenue.
    const channelRows = await tx
      .select({
        brand: sql<string>`coalesce(${sales.brand}, '')`,
        channel: sales.channel,
        revenue: sql<string>`coalesce(sum(${sales.totalPrice}), 0)::text`,
        transactions: sql<number>`count(*)::int`,
      })
      .from(sales)
      .where(and(...filters))
      .groupBy(sql`coalesce(${sales.brand}, '')`, sales.channel);

    const channelByBrand = new Map<
      string,
      BrandBreakdownRow["byChannel"]
    >();
    for (const r of channelRows) {
      const b = String(r.brand ?? "");
      const bucket =
        channelByBrand.get(b) ?? {
          store: { revenue: 0, transactions: 0 },
          online: { revenue: 0, transactions: 0 },
        };
      const slot = r.channel === "online" ? bucket.online : bucket.store;
      slot.revenue = Number(r.revenue ?? 0);
      slot.transactions = Number(r.transactions ?? 0);
      channelByBrand.set(b, bucket);
    }

    const out: BrandBreakdownRow[] = totalsRows.map((r) => {
      const key = String(r.brand ?? "");
      const revenue = Number(r.revenue ?? 0);
      const cost = Number(r.cost ?? 0);
      const transactions = Number(r.transactions ?? 0);
      const grossProfit = revenue - cost;
      return {
        brand: key === "" ? "—" : key,
        revenue,
        cost,
        discounts: Number(r.discounts ?? 0),
        grossProfit,
        margin: revenue === 0 ? 0 : (grossProfit / revenue) * 100,
        unitsSold: Number(r.unitsSold ?? 0),
        transactions,
        aov: transactions === 0 ? 0 : revenue / transactions,
        byChannel:
          channelByBrand.get(key) ?? {
            store: { revenue: 0, transactions: 0 },
            online: { revenue: 0, transactions: 0 },
          },
      };
    });

    // Highest-revenue brand on top — matches the branch-comparison ordering.
    out.sort((a, b) => b.revenue - a.revenue);

    const totals = out.reduce(
      (acc, r) => {
        acc.revenue += r.revenue;
        acc.cost += r.cost;
        acc.grossProfit += r.grossProfit;
        acc.transactions += r.transactions;
        return acc;
      },
      { revenue: 0, cost: 0, grossProfit: 0, transactions: 0 },
    );

    return {
      window: window
        ? { from: window.from.toISOString(), to: window.to.toISOString() }
        : null,
      rows: out,
      totals: {
        ...totals,
        margin: totals.revenue === 0 ? 0 : (totals.grossProfit / totals.revenue) * 100,
      },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) Product drill-down — daily trend + qty + margin for one product
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductDrillDown {
  productId: string;
  productName: string;
  brand: string | null;
  window: { from: string; to: string } | null;
  totals: {
    revenue: number;
    cost: number;
    grossProfit: number;
    margin: number;
    unitsSold: number;
    transactions: number;
    aov: number;
  };
  daily: Array<{
    date: string;
    revenue: number;
    units: number;
  }>;
}

export async function loadProductDrillDown(
  tenantId: string,
  productId: string,
  window: { from: Date; to: Date } | null,
  branchId: string | null,
): Promise<ProductDrillDown | null> {
  return withTenant(tenantId, async (tx) => {
    const branchFilter = branchId ? eq(sales.branchId, branchId) : undefined;
    const filters = [
      eq(sales.tenantId, tenantId),
      eq(sales.productId, productId),
    ];
    if (window) {
      filters.push(
        gte(sales.saleDate, window.from),
        lte(sales.saleDate, window.to),
      );
    }
    if (branchFilter) filters.push(branchFilter);

    const [totals] = await tx
      .select({
        revenue: sql<string>`coalesce(sum(${sales.totalPrice}), 0)::text`,
        cost: sql<string>`coalesce(sum(
          coalesce(${sales.costPriceAtSale}, ${products.costPrice}, 0)
            * ${sales.quantitySold}
        ), 0)::text`,
        units: sql<number>`coalesce(sum(${sales.quantitySold}), 0)::int`,
        transactions: sql<number>`count(*)::int`,
        productName: sales.productName,
        brand: sales.brand,
      })
      .from(sales)
      .leftJoin(products, eq(products.id, sales.productId))
      .where(and(...filters))
      .groupBy(sales.productName, sales.brand)
      .limit(1);

    // Even if there are no sales in this window, we still want to surface the
    // product's identity so the UI can render a graceful empty state.
    const [meta] = await tx
      .select({ name: products.name, brand: products.brand })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, productId)))
      .limit(1);
    if (!meta) return null;

    const dailyRows = await tx
      .select({
        day: sql<Date>`date_trunc('day', ${sales.saleDate})`,
        revenue: sql<string>`coalesce(sum(${sales.totalPrice}), 0)::text`,
        units: sql<number>`coalesce(sum(${sales.quantitySold}), 0)::int`,
      })
      .from(sales)
      .where(and(...filters))
      .groupBy(sql`date_trunc('day', ${sales.saleDate})`)
      .orderBy(sql`date_trunc('day', ${sales.saleDate})`);

    const daily = dailyRows.map((r) => ({
      date: format(new Date(r.day as unknown as string), "MMM dd"),
      revenue: Number(r.revenue ?? 0),
      units: Number(r.units ?? 0),
    }));

    const revenue = Number(totals?.revenue ?? 0);
    const cost = Number(totals?.cost ?? 0);
    const units = Number(totals?.units ?? 0);
    const transactions = Number(totals?.transactions ?? 0);
    const grossProfit = revenue - cost;
    const margin = revenue === 0 ? 0 : (grossProfit / revenue) * 100;
    const aov = transactions === 0 ? 0 : revenue / transactions;

    return {
      productId,
      productName: totals?.productName ?? meta.name,
      brand: totals?.brand ?? meta.brand ?? null,
      window: window
        ? { from: window.from.toISOString(), to: window.to.toISOString() }
        : null,
      totals: {
        revenue,
        cost,
        grossProfit,
        margin,
        unitsSold: units,
        transactions,
        aov,
      },
      daily,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Product search helper — surfaces the top matches for the drill-down picker.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductSearchHit {
  id: string;
  name: string;
  brand: string | null;
  totalRevenue: number;
  unitsSold: number;
}

export async function searchDrillableProducts(
  tenantId: string,
  query: string,
  window: { from: Date; to: Date } | null,
  branchId: string | null,
  limit = 12,
): Promise<ProductSearchHit[]> {
  return withTenant(tenantId, async (tx) => {
    // Empty query → return the best-selling products for the window so the
    // user has something to click without typing.
    const branchFilter = branchId ? eq(sales.branchId, branchId) : undefined;
    const salesFilters = [eq(sales.tenantId, tenantId)];
    if (window) {
      salesFilters.push(
        gte(sales.saleDate, window.from),
        lte(sales.saleDate, window.to),
      );
    }
    if (branchFilter) salesFilters.push(branchFilter);

    const like = `%${query.trim()}%`;
    const nameFilter =
      query.trim().length > 0
        ? or(
            ilike(sales.productName, like),
            ilike(sales.brand, like),
          )
        : undefined;
    if (nameFilter) salesFilters.push(nameFilter);

    const rows = await tx
      .select({
        id: sales.productId,
        name: sales.productName,
        brand: sales.brand,
        revenue: sql<string>`coalesce(sum(${sales.totalPrice}), 0)::text`,
        units: sql<number>`coalesce(sum(${sales.quantitySold}), 0)::int`,
      })
      .from(sales)
      .where(and(...salesFilters))
      .groupBy(sales.productId, sales.productName, sales.brand)
      .orderBy(desc(sql`sum(${sales.totalPrice})`))
      .limit(limit);

    return rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      brand: r.brand ?? null,
      totalRevenue: Number(r.revenue ?? 0),
      unitsSold: Number(r.units ?? 0),
    }));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Small local date/day helpers so each report doesn't reinvent them.
// ─────────────────────────────────────────────────────────────────────────────

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
function addDays(d: Date, delta: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + delta);
  return x;
}
function dayKey(d: Date): string {
  return format(startOfDay(d), "yyyy-MM-dd");
}
function indexByDay(
  rows: Array<{ day: unknown; revenue: string | null }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const day = new Date(r.day as string);
    out.set(dayKey(day), Number(r.revenue ?? 0));
  }
  return out;
}
