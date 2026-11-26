// Phase B P1 Wave 2 — authoritative read-only analytics the AI Agent exposes.
//
// Each helper runs ONE server-side SQL aggregation over existing tables; no new
// schema, no JS-side summing of large datasets. Timezone-aware groupings use
// the tenant reporting timezone (STORO_REPORTING_TZ, default Africa/Cairo) so
// "hour of day" and "day of week" match what a shop owner sees on the clock.
//
// These helpers wrap the transactional tables directly because:
//   - `inventory value` is a point-in-time snapshot (products.quantity ×
//     products.cost_price), with no pre-materialised source in Storo.
//   - `dead stock` / `zero-cost` / `avg basket` / `hour / dow` / `customer
//     activity` / `supplier price history` are pure projections over existing
//     rows. No denormalised cache exists today; introducing one would be
//     premature.
//
// Qualifying-sale definition (Wave 2):
//   - Average basket: `is_returned = false` (reversal-free order shape).
//   - Hour / day-of-week: include all sale rows (returned rows still describe
//     when traffic hit). This mirrors insights-deep's loadHeatmapReport.
//   - New/inactive customer: any sale row counts as a purchase (matches the
//     existing `get_top_customers` convention — sales are the authoritative
//     customer-interaction ledger in a model without a customers table).
//   - Dead-stock last-sale date: include all sale rows (returned/not) so a
//     returned sale still proves the product moved recently.

import { and, eq, gte, lte, sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { DEFAULT_REPORTING_TZ } from "@/lib/finance/dates";
import {
  categories,
  products,
  purchaseOrderItems,
  purchaseOrders,
  sales,
  suppliers,
} from "@/lib/db/schema";

const TZ_LITERAL = DEFAULT_REPORTING_TZ;

/* ──────────────────────────── W2.1 — inventory value ──────────────────── */

export interface InventoryValueCategoryRow {
  categoryId: string | null;
  categoryName: string | null;
  totalValue: number;
  productCount: number;
  totalQuantity: number;
}

export interface InventoryValueResult {
  totalValue: number;
  productCount: number;
  totalQuantity: number;
  /** When a specific category is requested this holds that one row. Otherwise
   *  it's the top-N category rollup, sorted by totalValue desc. */
  categories: InventoryValueCategoryRow[];
  /** Products where cost_price IS NULL / 0 that were excluded from the sum.
   *  Surfaced so the Agent can flag the understatement; callers can dig in
   *  via `get_zero_cost_products`. */
  excludedProductCount: number;
  filterCategoryId: string | null;
}

/**
 * On-hand inventory valuation at COST (not selling price). Products with a
 * null / zero cost don't contribute to totalValue and are tallied separately
 * as `excludedProductCount`.
 */
export async function computeInventoryValue(
  tenantId: string,
  opts: { categoryId?: string | null; categoryLimit?: number } = {},
): Promise<InventoryValueResult> {
  const categoryId = opts.categoryId ?? null;
  const categoryLimit = Math.min(Math.max(1, opts.categoryLimit ?? 10), 50);

  return withTenant(tenantId, async (tx) => {
    const baseFilters = [eq(products.tenantId, tenantId)];
    if (categoryId) baseFilters.push(eq(products.categoryId, categoryId));

    const [totals] = await tx
      .select({
        totalValue: sql<string>`coalesce(sum(case when ${products.costPrice} is null or ${products.costPrice}::numeric <= 0 then 0 else ${products.quantity} * ${products.costPrice}::numeric end), 0)::text`,
        productCount: sql<number>`count(*)::int`,
        totalQuantity: sql<number>`coalesce(sum(${products.quantity}), 0)::int`,
        excludedProductCount: sql<number>`sum(case when (${products.costPrice} is null or ${products.costPrice}::numeric <= 0) and ${products.quantity} > 0 then 1 else 0 end)::int`,
      })
      .from(products)
      .where(and(...baseFilters));

    const categoryRows = await tx
      .select({
        categoryId: products.categoryId,
        categoryName: sql<string>`max(${categories.label})`,
        totalValue: sql<string>`coalesce(sum(case when ${products.costPrice} is null or ${products.costPrice}::numeric <= 0 then 0 else ${products.quantity} * ${products.costPrice}::numeric end), 0)::text`,
        productCount: sql<number>`count(*)::int`,
        totalQuantity: sql<number>`coalesce(sum(${products.quantity}), 0)::int`,
      })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(and(...baseFilters))
      .groupBy(products.categoryId)
      .orderBy(sql`coalesce(sum(case when ${products.costPrice} is null or ${products.costPrice}::numeric <= 0 then 0 else ${products.quantity} * ${products.costPrice}::numeric end), 0) desc`)
      .limit(categoryLimit);

    return {
      totalValue: Number(totals?.totalValue ?? 0),
      productCount: Number(totals?.productCount ?? 0),
      totalQuantity: Number(totals?.totalQuantity ?? 0),
      excludedProductCount: Number(totals?.excludedProductCount ?? 0),
      filterCategoryId: categoryId,
      categories: categoryRows.map((r) => ({
        categoryId: r.categoryId ?? null,
        categoryName: r.categoryName ?? null,
        totalValue: Number(r.totalValue ?? 0),
        productCount: Number(r.productCount ?? 0),
        totalQuantity: Number(r.totalQuantity ?? 0),
      })),
    };
  });
}

/* ────────────────────────────── W2.2 — dead stock ─────────────────────── */

export type DeadStockClassification = "never_sold" | "inactive";

export interface DeadStockRow {
  productId: string;
  productName: string;
  sku: string | null;
  categoryId: string | null;
  categoryName: string | null;
  quantity: number;
  costPrice: number | null;
  sellingPrice: number;
  lastSaleDate: Date | null;
  daysSinceLastSale: number | null;
  classification: DeadStockClassification;
}

export interface DeadStockResult {
  thresholdDays: number;
  rows: DeadStockRow[];
  totalCount: number;
  neverSoldCount: number;
  inactiveCount: number;
  tiedUpValue: number;
}

export interface DeadStockOptions {
  thresholdDays: number;
  categoryId?: string | null;
  minQuantity?: number;
  includeZeroStock?: boolean;
  limit?: number;
}

/**
 * Products that aren't moving. The SQL aggregates sale dates per product in
 * the same query that filters stock, so there's no N+1.
 *
 * Defaults keep the result aligned with the user intent ("show me stock
 * that's tying up money"): quantity > 0 unless `includeZeroStock=true`.
 */
export async function computeDeadStockProducts(
  tenantId: string,
  opts: DeadStockOptions,
): Promise<DeadStockResult> {
  const thresholdDays = Math.max(1, Math.floor(opts.thresholdDays));
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const minQty = opts.includeZeroStock ? 0 : Math.max(0, opts.minQuantity ?? 1);
  const filterCategoryId = opts.categoryId ?? null;

  return withTenant(tenantId, async (tx) => {
    const cutoff = sql`now() - make_interval(days => ${thresholdDays})`;

    const productFilters = [eq(products.tenantId, tenantId)];
    if (filterCategoryId) productFilters.push(eq(products.categoryId, filterCategoryId));

    const lastSaleSub = tx
      .select({
        productId: sales.productId,
        lastSaleDate: sql<Date>`max(${sales.saleDate})`.as("last_sale_date"),
      })
      .from(sales)
      .where(eq(sales.tenantId, tenantId))
      .groupBy(sales.productId)
      .as("last_sale");

    const rows = await tx
      .select({
        productId: products.id,
        productName: products.name,
        sku: products.sku,
        categoryId: products.categoryId,
        categoryName: sql<string>`${categories.label}`,
        quantity: products.quantity,
        costPrice: products.costPrice,
        sellingPrice: products.price,
        lastSaleDate: lastSaleSub.lastSaleDate,
      })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .leftJoin(lastSaleSub, eq(lastSaleSub.productId, products.id))
      .where(
        and(
          ...productFilters,
          sql`${products.quantity} >= ${minQty}`,
          // "Dead": no sale OR last sale older than cutoff.
          sql`${lastSaleSub.lastSaleDate} is null or ${lastSaleSub.lastSaleDate} < ${cutoff}`,
        ),
      )
      .orderBy(sql`coalesce(${products.quantity}, 0) desc`)
      .limit(limit);

    const now = Date.now();
    const out: DeadStockRow[] = rows.map((r) => {
      const last = r.lastSaleDate ? new Date(r.lastSaleDate) : null;
      const classification: DeadStockClassification = last ? "inactive" : "never_sold";
      const daysSince =
        last == null
          ? null
          : Math.floor((now - last.getTime()) / (24 * 60 * 60 * 1000));
      return {
        productId: r.productId,
        productName: r.productName,
        sku: r.sku,
        categoryId: r.categoryId ?? null,
        categoryName: r.categoryName ?? null,
        quantity: r.quantity ?? 0,
        costPrice: r.costPrice == null ? null : Number(r.costPrice),
        sellingPrice: Number(r.sellingPrice ?? 0),
        lastSaleDate: last,
        daysSinceLastSale: daysSince,
        classification,
      };
    });

    const neverSoldCount = out.filter((r) => r.classification === "never_sold").length;
    const inactiveCount = out.length - neverSoldCount;
    const tiedUpValue = out.reduce(
      (s, r) => s + (r.costPrice ?? 0) * (r.quantity ?? 0),
      0,
    );

    return {
      thresholdDays,
      rows: out,
      totalCount: out.length,
      neverSoldCount,
      inactiveCount,
      tiedUpValue: Math.round(tiedUpValue * 100) / 100,
    };
  });
}

/* ────────────────────────── W2.3 — zero-cost products ─────────────────── */

export type ZeroCostKind = "null_cost" | "zero_cost";

export interface ZeroCostRow {
  productId: string;
  productName: string;
  sku: string | null;
  categoryId: string | null;
  categoryName: string | null;
  quantity: number;
  sellingPrice: number;
  costPrice: number | null;
  kind: ZeroCostKind;
}

export interface ZeroCostResult {
  nullCostCount: number;
  zeroCostCount: number;
  totalCount: number;
  rows: ZeroCostRow[];
}

export async function computeZeroCostProducts(
  tenantId: string,
  opts: { kind?: ZeroCostKind | "any"; categoryId?: string | null; limit?: number } = {},
): Promise<ZeroCostResult> {
  const kind = opts.kind ?? "any";
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
  const filterCategoryId = opts.categoryId ?? null;

  return withTenant(tenantId, async (tx) => {
    const filters = [eq(products.tenantId, tenantId)];
    if (filterCategoryId) filters.push(eq(products.categoryId, filterCategoryId));
    if (kind === "null_cost") filters.push(sql`${products.costPrice} is null`);
    else if (kind === "zero_cost")
      filters.push(sql`${products.costPrice} is not null and ${products.costPrice}::numeric = 0`);
    else
      filters.push(
        sql`${products.costPrice} is null or ${products.costPrice}::numeric = 0`,
      );

    const rows = await tx
      .select({
        productId: products.id,
        productName: products.name,
        sku: products.sku,
        categoryId: products.categoryId,
        categoryName: sql<string>`${categories.label}`,
        quantity: products.quantity,
        sellingPrice: products.price,
        costPrice: products.costPrice,
      })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(and(...filters))
      .orderBy(sql`${products.quantity} desc nulls last`)
      .limit(limit);

    let nullCount = 0;
    let zeroCount = 0;
    const out: ZeroCostRow[] = rows.map((r) => {
      const cost = r.costPrice;
      const rowKind: ZeroCostKind = cost == null ? "null_cost" : "zero_cost";
      if (rowKind === "null_cost") nullCount += 1;
      else zeroCount += 1;
      return {
        productId: r.productId,
        productName: r.productName,
        sku: r.sku,
        categoryId: r.categoryId ?? null,
        categoryName: r.categoryName ?? null,
        quantity: r.quantity ?? 0,
        sellingPrice: Number(r.sellingPrice ?? 0),
        costPrice: cost == null ? null : Number(cost),
        kind: rowKind,
      };
    });

    return {
      nullCostCount: nullCount,
      zeroCostCount: zeroCount,
      totalCount: out.length,
      rows: out,
    };
  });
}

/* ───────────────────────── W2.4 — average basket size ─────────────────── */

export interface AverageBasketResult {
  window: { from: Date; to: Date } | null;
  currency: "EGP";
  invoiceCount: number;
  totalRevenue: number;
  averageBasket: number;
}

/**
 * Average invoice value for qualifying (non-returned) sales. "Invoice" is the
 * `invoice_id` text column (groups cart lines); rows with null `invoice_id`
 * (one-off legacy sales) each count as their own invoice via COALESCE to the
 * row id.
 */
export async function computeAverageBasket(
  tenantId: string,
  window: { from: Date; to: Date } | null,
): Promise<AverageBasketResult> {
  return withTenant(tenantId, async (tx) => {
    const filters = [eq(sales.tenantId, tenantId), eq(sales.isReturned, false)];
    if (window) {
      filters.push(gte(sales.saleDate, window.from));
      filters.push(lte(sales.saleDate, window.to));
    }

    const [row] = await tx
      .select({
        invoiceCount: sql<number>`count(distinct coalesce(${sales.invoiceId}, ${sales.id}::text))::int`,
        totalRevenue: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
      })
      .from(sales)
      .where(and(...filters));

    const invoiceCount = Number(row?.invoiceCount ?? 0);
    const totalRevenue = Number(row?.totalRevenue ?? 0);
    const avg = invoiceCount > 0 ? totalRevenue / invoiceCount : 0;
    return {
      window,
      currency: "EGP",
      invoiceCount,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      averageBasket: Math.round(avg * 100) / 100,
    };
  });
}

/* ───────────── W2.5 / W2.6 — sales by hour + day of week ──────────────── */

export interface HourBucket {
  hour: number;
  salesCount: number;
  revenue: number;
  quantity: number;
}

export interface DowBucket {
  /** 0=Sunday (JS convention) … 6=Saturday, matching the shop timezone. */
  dow: number;
  salesCount: number;
  revenue: number;
  quantity: number;
}

export interface SalesByHourResult {
  window: { from: Date; to: Date } | null;
  timezone: string;
  buckets: HourBucket[];
  peak: HourBucket | null;
}

export interface SalesByDowResult {
  window: { from: Date; to: Date } | null;
  timezone: string;
  buckets: DowBucket[];
  peak: DowBucket | null;
}

async function loadHourDowAgg(
  tenantId: string,
  window: { from: Date; to: Date } | null,
  group: "hour" | "dow",
): Promise<Array<{ bucket: number; revenue: number; count: number; qty: number }>> {
  return withTenant(tenantId, async (tx) => {
    const filters = [eq(sales.tenantId, tenantId), eq(sales.isReturned, false)];
    if (window) {
      filters.push(gte(sales.saleDate, window.from));
      filters.push(lte(sales.saleDate, window.to));
    }
    const bucketExpr =
      group === "hour"
        ? sql<number>`extract(hour from (${sales.saleDate} at time zone ${TZ_LITERAL}))::int`
        : sql<number>`extract(dow from (${sales.saleDate} at time zone ${TZ_LITERAL}))::int`;

    const rows = await tx
      .select({
        bucket: bucketExpr.as("bucket"),
        revenue: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
        count: sql<number>`count(*)::int`,
        qty: sql<number>`coalesce(sum(${sales.quantitySold}), 0)::int`,
      })
      .from(sales)
      .where(and(...filters))
      .groupBy(sql`bucket`);

    return rows.map((r) => ({
      bucket: Number(r.bucket),
      revenue: Number(r.revenue ?? 0),
      count: Number(r.count ?? 0),
      qty: Number(r.qty ?? 0),
    }));
  });
}

export async function computeSalesByHour(
  tenantId: string,
  window: { from: Date; to: Date } | null,
): Promise<SalesByHourResult> {
  const raw = await loadHourDowAgg(tenantId, window, "hour");
  const byBucket = new Map(raw.map((r) => [r.bucket, r]));
  const buckets: HourBucket[] = [];
  let peak: HourBucket | null = null;
  for (let h = 0; h < 24; h += 1) {
    const r = byBucket.get(h);
    const bucket: HourBucket = {
      hour: h,
      salesCount: r?.count ?? 0,
      revenue: Math.round((r?.revenue ?? 0) * 100) / 100,
      quantity: r?.qty ?? 0,
    };
    buckets.push(bucket);
    if (!peak || bucket.revenue > peak.revenue) peak = bucket;
  }
  // Peak only "real" if it has activity.
  if (peak && peak.salesCount === 0) peak = null;
  return { window, timezone: TZ_LITERAL, buckets, peak };
}

export async function computeSalesByDow(
  tenantId: string,
  window: { from: Date; to: Date } | null,
): Promise<SalesByDowResult> {
  const raw = await loadHourDowAgg(tenantId, window, "dow");
  const byBucket = new Map(raw.map((r) => [r.bucket, r]));
  const buckets: DowBucket[] = [];
  let peak: DowBucket | null = null;
  for (let d = 0; d < 7; d += 1) {
    const r = byBucket.get(d);
    const bucket: DowBucket = {
      dow: d,
      salesCount: r?.count ?? 0,
      revenue: Math.round((r?.revenue ?? 0) * 100) / 100,
      quantity: r?.qty ?? 0,
    };
    buckets.push(bucket);
    if (!peak || bucket.revenue > peak.revenue) peak = bucket;
  }
  if (peak && peak.salesCount === 0) peak = null;
  return { window, timezone: TZ_LITERAL, buckets, peak };
}

/* ───────────────────────── W2.7 — new customers ───────────────────────── */

export interface NewCustomerRow {
  customerPhone: string;
  customerName: string | null;
  firstPurchaseDate: Date;
  firstPurchaseAmount: number;
}

export interface NewCustomersResult {
  window: { from: Date; to: Date };
  count: number;
  rows: NewCustomerRow[];
}

/**
 * Customers whose FIRST qualifying purchase (min sale_date) falls inside the
 * window. Storo has no customers table — the sales ledger is authoritative
 * for "customer interaction history". The `customer_phone` column is the
 * identity key.
 */
export async function computeNewCustomers(
  tenantId: string,
  window: { from: Date; to: Date },
  opts: { limit?: number } = {},
): Promise<NewCustomersResult> {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  return withTenant(tenantId, async (tx) => {
    // Per-customer first-ever purchase, then filter to the window.
    const firstBuySub = tx
      .select({
        customerPhone: sales.customerPhone,
        customerName: sql<string>`max(${sales.customerName})`.as("customer_name"),
        firstDate: sql<Date>`min(${sales.saleDate})`.as("first_date"),
      })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, tenantId),
          sql`${sales.customerPhone} is not null and ${sales.customerPhone} <> ''`,
        ),
      )
      .groupBy(sales.customerPhone)
      .as("first_buy");

    // The subquery's `first_date` column is sql<Date>, which doesn't carry the
    // drizzle timestamp serialiser. Pass ISO strings + cast on the DB side so
    // postgres-js gets a text param it can hand to timestamptz.
    const fromIso = window.from.toISOString();
    const toIso = window.to.toISOString();

    const rows = await tx
      .select({
        customerPhone: firstBuySub.customerPhone,
        customerName: firstBuySub.customerName,
        firstPurchaseDate: firstBuySub.firstDate,
        firstPurchaseAmount: sql<string>`(
          select coalesce(sum(s2.total_price::numeric), 0)::text
          from sales s2
          where s2.tenant_id = ${tenantId}
            and s2.customer_phone = ${firstBuySub.customerPhone}
            and s2.sale_date = ${firstBuySub.firstDate}
        )`,
      })
      .from(firstBuySub)
      .where(
        and(
          sql`${firstBuySub.firstDate} >= ${fromIso}::timestamptz`,
          sql`${firstBuySub.firstDate} <= ${toIso}::timestamptz`,
        ),
      )
      .orderBy(sql`${firstBuySub.firstDate} desc`)
      .limit(limit);

    const [countRow] = await tx
      .select({
        total: sql<number>`count(*)::int`,
      })
      .from(firstBuySub)
      .where(
        and(
          sql`${firstBuySub.firstDate} >= ${fromIso}::timestamptz`,
          sql`${firstBuySub.firstDate} <= ${toIso}::timestamptz`,
        ),
      );

    return {
      window,
      count: Number(countRow?.total ?? rows.length),
      rows: rows.map((r) => ({
        customerPhone: r.customerPhone ?? "",
        customerName: r.customerName ?? null,
        firstPurchaseDate: new Date(r.firstPurchaseDate),
        firstPurchaseAmount: Number(r.firstPurchaseAmount ?? 0),
      })),
    };
  });
}

/* ──────────────────────── W2.8 — inactive customers ───────────────────── */

export interface InactiveCustomerRow {
  customerPhone: string;
  customerName: string | null;
  lastPurchaseDate: Date;
  daysSinceLastPurchase: number;
  lifetimeInvoiceCount: number;
  lifetimeValue: number;
}

export interface InactiveCustomersResult {
  thresholdDays: number;
  count: number;
  rows: InactiveCustomerRow[];
}

/**
 * Customers with ≥1 lifetime purchase whose LAST purchase (max sale_date) is
 * older than `thresholdDays`. Never-purchased customers are NOT included —
 * the model has no such entity (sales are the only customer ledger).
 */
export async function computeInactiveCustomers(
  tenantId: string,
  opts: { thresholdDays: number; limit?: number },
): Promise<InactiveCustomersResult> {
  const thresholdDays = Math.max(1, Math.floor(opts.thresholdDays));
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  return withTenant(tenantId, async (tx) => {
    const cutoff = sql`now() - make_interval(days => ${thresholdDays})`;

    const rows = await tx
      .select({
        customerPhone: sales.customerPhone,
        customerName: sql<string>`max(${sales.customerName})`,
        lastPurchaseDate: sql<Date>`max(${sales.saleDate})`,
        lifetimeInvoiceCount: sql<number>`count(distinct coalesce(${sales.invoiceId}, ${sales.id}::text))::int`,
        lifetimeValue: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
      })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, tenantId),
          sql`${sales.customerPhone} is not null and ${sales.customerPhone} <> ''`,
        ),
      )
      .groupBy(sales.customerPhone)
      .having(sql`max(${sales.saleDate}) < ${cutoff}`)
      .orderBy(sql`max(${sales.saleDate}) asc`)
      .limit(limit);

    const now = Date.now();
    const shaped: InactiveCustomerRow[] = rows.map((r) => {
      const last = new Date(r.lastPurchaseDate);
      return {
        customerPhone: r.customerPhone ?? "",
        customerName: r.customerName ?? null,
        lastPurchaseDate: last,
        daysSinceLastPurchase: Math.floor((now - last.getTime()) / (24 * 60 * 60 * 1000)),
        lifetimeInvoiceCount: Number(r.lifetimeInvoiceCount ?? 0),
        lifetimeValue: Number(r.lifetimeValue ?? 0),
      };
    });

    return {
      thresholdDays,
      count: shaped.length,
      rows: shaped,
    };
  });
}

/* ───────────────────── W2.9 — supplier price history ──────────────────── */

export interface SupplierPriceRow {
  purchaseOrderId: string;
  purchaseOrderOrderDate: Date;
  productId: string | null;
  productName: string;
  unitCost: number;
  quantity: number;
}

export interface SupplierPriceAggregate {
  firstCost: number;
  firstDate: Date;
  latestCost: number;
  latestDate: Date;
  costDelta: number;
  costChangePct: number;
  observationCount: number;
}

export interface SupplierPriceHistoryResult {
  supplierId: string;
  supplierName: string | null;
  productId: string | null;
  window: { from: Date | null; to: Date | null };
  rows: SupplierPriceRow[];
  aggregate: SupplierPriceAggregate | null;
}

/**
 * Timeline of `purchase_order_items.unit_cost` for one supplier, optionally
 * narrowed to one product. Pulls from the authoritative transactional table —
 * no derived price-history cache exists (nor should one before the data
 * warrants it).
 *
 * When `productId` is passed we also return an aggregate (first/latest/delta)
 * so the Agent can reason about price change without summing itself. Without
 * a product filter the aggregate is null — mixing multiple products into one
 * trend would be misleading.
 */
export async function computeSupplierPriceHistory(
  tenantId: string,
  supplierId: string,
  opts: { productId?: string | null; from?: Date; to?: Date; limit?: number } = {},
): Promise<SupplierPriceHistoryResult> {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const productId = opts.productId ?? null;
  return withTenant(tenantId, async (tx) => {
    const filters = [
      eq(purchaseOrders.tenantId, tenantId),
      eq(purchaseOrders.supplierId, supplierId),
      eq(purchaseOrderItems.tenantId, tenantId),
    ];
    if (productId) filters.push(eq(purchaseOrderItems.productId, productId));
    if (opts.from) filters.push(gte(purchaseOrders.orderDate, opts.from));
    if (opts.to) filters.push(lte(purchaseOrders.orderDate, opts.to));

    const rows = await tx
      .select({
        purchaseOrderId: purchaseOrders.id,
        orderDate: purchaseOrders.orderDate,
        productId: purchaseOrderItems.productId,
        productName: purchaseOrderItems.productName,
        unitCost: purchaseOrderItems.unitCost,
        quantity: purchaseOrderItems.quantity,
      })
      .from(purchaseOrderItems)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderItems.purchaseOrderId))
      .where(and(...filters))
      .orderBy(sql`${purchaseOrders.orderDate} desc`)
      .limit(limit);

    const [sup] = await tx
      .select({ id: suppliers.id, name: suppliers.name })
      .from(suppliers)
      .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.id, supplierId)))
      .limit(1);

    const shaped: SupplierPriceRow[] = rows.map((r) => ({
      purchaseOrderId: r.purchaseOrderId,
      purchaseOrderOrderDate: new Date(r.orderDate),
      productId: r.productId ?? null,
      productName: r.productName,
      unitCost: Number(r.unitCost),
      quantity: r.quantity,
    }));

    let aggregate: SupplierPriceAggregate | null = null;
    if (productId && shaped.length > 0) {
      // rows are DESC by date → first = latest, last = earliest
      const latest = shaped[0]!;
      const earliest = shaped[shaped.length - 1]!;
      const delta = latest.unitCost - earliest.unitCost;
      const pct = earliest.unitCost === 0 ? 0 : (delta / earliest.unitCost) * 100;
      aggregate = {
        firstCost: earliest.unitCost,
        firstDate: earliest.purchaseOrderOrderDate,
        latestCost: latest.unitCost,
        latestDate: latest.purchaseOrderOrderDate,
        costDelta: Math.round(delta * 100) / 100,
        costChangePct: Math.round(pct * 100) / 100,
        observationCount: shaped.length,
      };
    }

    return {
      supplierId,
      supplierName: sup?.name ?? null,
      productId,
      window: { from: opts.from ?? null, to: opts.to ?? null },
      rows: shaped,
      aggregate,
    };
  });
}
