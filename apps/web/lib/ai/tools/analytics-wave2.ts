// Phase B P1 Wave 2 — Agent tools that expose the authoritative analytics
// helpers in `lib/repo/analytics-wave2.ts`. Each tool is a thin wrapper:
// parse args, resolve window, call the repo, shape the response. No business
// logic in this layer — accounting conventions + aggregation live in the repo.

import {
  computeAverageBasket,
  computeDeadStockProducts,
  computeInactiveCustomers,
  computeInventoryValue,
  computeNewCustomers,
  computeSalesByDow,
  computeSalesByHour,
  computeSupplierPriceHistory,
  computeZeroCostProducts,
} from "@/lib/repo/analytics-wave2";

import type { Tool } from "./types";
import {
  DATE_FROM_SCHEMA,
  DATE_TO_SCHEMA,
  PERIOD_SCHEMA,
  parseLimit,
  resolveWindow,
} from "./_shared";

/* ─────────────────────── get_inventory_value ─────────────────────────── */

export const getInventoryValue: Tool = {
  name: "get_inventory_value",
  description:
    "On-hand inventory VALUE AT COST — Σ(quantity × cost_price) across every product in the tenant, optionally scoped to a category. Use for 'how much is my stock worth?', 'قيمة المخزون كام؟', 'ودي البضاعة حاطتلي فيها كام فلوس؟'. NOT the same as COGS (use get_pnl for that). Products with null/zero cost are excluded from the sum and tallied as `excludedProductCount` so the number is never silently understated.",
  requiredPermission: "view_inventory",
  parameters: {
    type: "object",
    properties: {
      category_id: {
        type: "string",
        description: "Optional category uuid to scope the valuation to a single category.",
      },
      category_breakdown_limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Max category rollup rows to return (default 10).",
      },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const categoryId = typeof args.category_id === "string" && args.category_id.trim() !== ""
      ? args.category_id.trim()
      : null;
    const result = await computeInventoryValue(ctx.tenantId, {
      categoryId,
      categoryLimit: parseLimit(args.category_breakdown_limit, 10, 50),
    });
    return {
      ok: true,
      data: {
        currency: "EGP",
        basis: "current_cost_price",
        filterCategoryId: result.filterCategoryId,
        totalValue: Math.round(result.totalValue * 100) / 100,
        productCount: result.productCount,
        totalQuantity: result.totalQuantity,
        excludedProductCount: result.excludedProductCount,
        categoryBreakdown: result.categories.map((c) => ({
          categoryId: c.categoryId,
          categoryName: c.categoryName,
          totalValue: Math.round(c.totalValue * 100) / 100,
          productCount: c.productCount,
          totalQuantity: c.totalQuantity,
        })),
      },
    };
  },
};

/* ──────────────────────── get_dead_stock_products ────────────────────── */

export const getDeadStockProducts: Tool = {
  name: "get_dead_stock_products",
  description:
    "Products that aren't moving: no sale within the last `days` (default 30). By default excludes zero-stock (dead stock is capital tied up in unsold inventory). Each row is classified 'inactive' (sold historically but quiet now) or 'never_sold' (no sale ever). Returns totalCount, neverSoldCount, inactiveCount, and tiedUpValue = Σ(qty × cost). Use for 'المنتجات اللي نايمة', 'what's dead stock?', 'products not selling'.",
  requiredPermission: "view_inventory",
  parameters: {
    type: "object",
    properties: {
      days: {
        type: "integer",
        minimum: 1,
        maximum: 365,
        description: "Threshold in days. A product is dead when its last sale is older than this (default 30).",
      },
      category_id: { type: "string", description: "Optional category uuid filter." },
      min_quantity: {
        type: "integer",
        minimum: 0,
        maximum: 10_000,
        description: "Minimum on-hand quantity to include (default 1 — excludes zero-stock).",
      },
      include_zero_stock: {
        type: "boolean",
        description: "Include zero-stock rows (default false). When true, min_quantity is ignored.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        description: "Max rows to return (default 50).",
      },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const days = typeof args.days === "number" && args.days > 0 ? Math.floor(args.days) : 30;
    const categoryId = typeof args.category_id === "string" && args.category_id.trim() !== ""
      ? args.category_id.trim()
      : null;
    const result = await computeDeadStockProducts(ctx.tenantId, {
      thresholdDays: days,
      categoryId,
      minQuantity: typeof args.min_quantity === "number" ? args.min_quantity : 1,
      includeZeroStock: args.include_zero_stock === true,
      limit: parseLimit(args.limit, 50, 200),
    });
    return {
      ok: true,
      data: {
        currency: "EGP",
        thresholdDays: result.thresholdDays,
        totalCount: result.totalCount,
        neverSoldCount: result.neverSoldCount,
        inactiveCount: result.inactiveCount,
        tiedUpValue: result.tiedUpValue,
        rows: result.rows.map((r) => ({
          productId: r.productId,
          productName: r.productName,
          sku: r.sku,
          categoryId: r.categoryId,
          categoryName: r.categoryName,
          quantity: r.quantity,
          costPrice: r.costPrice,
          sellingPrice: r.sellingPrice,
          lastSaleDate: r.lastSaleDate ? r.lastSaleDate.toISOString() : null,
          daysSinceLastSale: r.daysSinceLastSale,
          classification: r.classification,
        })),
      },
    };
  },
};

/* ─────────────────────── get_zero_cost_products ──────────────────────── */

export const getZeroCostProducts: Tool = {
  name: "get_zero_cost_products",
  description:
    "Products missing a valid cost price. Distinguishes `null_cost` (cost_price IS NULL — never set) from `zero_cost` (cost_price = 0 — explicitly zero). Diagnostic only; does NOT update any product. Use for 'منتجات تكلفتها صفر', 'products with no cost', 'audit cost coverage'.",
  requiredPermission: "view_inventory",
  parameters: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["null_cost", "zero_cost", "any"],
        description: "Which bucket to return (default 'any' = union).",
      },
      category_id: { type: "string", description: "Optional category uuid filter." },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Max rows (default 100)." },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const kindRaw = args.kind;
    const kind: "null_cost" | "zero_cost" | "any" =
      kindRaw === "null_cost" || kindRaw === "zero_cost" ? kindRaw : "any";
    const categoryId = typeof args.category_id === "string" && args.category_id.trim() !== ""
      ? args.category_id.trim()
      : null;
    const result = await computeZeroCostProducts(ctx.tenantId, {
      kind,
      categoryId,
      limit: parseLimit(args.limit, 100, 500),
    });
    return {
      ok: true,
      data: {
        currency: "EGP",
        kindFilter: kind,
        nullCostCount: result.nullCostCount,
        zeroCostCount: result.zeroCostCount,
        totalCount: result.totalCount,
        rows: result.rows,
      },
    };
  },
};

/* ───────────────────── get_average_basket_size ───────────────────────── */

export const getAverageBasketSize: Tool = {
  name: "get_average_basket_size",
  description:
    "Average invoice value — total revenue ÷ distinct invoice count — for non-returned sales in the window. Use for 'متوسط الفاتورة كام؟', 'average order value', 'AOV this month'. Pass `period` preset OR explicit `from`+`to`.",
  requiredPermission: "view_sales",
  parameters: {
    type: "object",
    properties: {
      period: PERIOD_SCHEMA,
      from: DATE_FROM_SCHEMA,
      to: DATE_TO_SCHEMA,
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const resolved = resolveWindow(args);
    const result = await computeAverageBasket(ctx.tenantId, resolved.window);
    return {
      ok: true,
      data: {
        period: resolved.period,
        currency: result.currency,
        window: result.window
          ? {
              from: result.window.from.toISOString(),
              to: result.window.to.toISOString(),
            }
          : null,
        invoiceCount: result.invoiceCount,
        totalRevenue: result.totalRevenue,
        averageBasket: result.averageBasket,
      },
    };
  },
};

/* ──────────────────────── get_sales_by_hour ──────────────────────────── */

export const getSalesByHour: Tool = {
  name: "get_sales_by_hour",
  description:
    "Sales broken down by hour-of-day (0..23) in the tenant reporting timezone (Africa/Cairo by default). Returns 24 buckets with revenue, sales count and quantity, plus the peak hour. Use for 'أكتر ساعة ببيع فيها؟', 'busiest hour', 'when do customers buy most?'. Pass `period` preset OR explicit `from`+`to`.",
  requiredPermission: "view_sales",
  parameters: {
    type: "object",
    properties: {
      period: PERIOD_SCHEMA,
      from: DATE_FROM_SCHEMA,
      to: DATE_TO_SCHEMA,
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const resolved = resolveWindow(args);
    const result = await computeSalesByHour(ctx.tenantId, resolved.window);
    return {
      ok: true,
      data: {
        period: resolved.period,
        currency: "EGP",
        timezone: result.timezone,
        window: result.window
          ? {
              from: result.window.from.toISOString(),
              to: result.window.to.toISOString(),
            }
          : null,
        peak: result.peak,
        buckets: result.buckets,
      },
    };
  },
};

/* ───────────────────── get_sales_by_day_of_week ──────────────────────── */

const DOW_LABELS: Record<number, { en: string; ar: string }> = {
  0: { en: "Sunday", ar: "الأحد" },
  1: { en: "Monday", ar: "الإثنين" },
  2: { en: "Tuesday", ar: "الثلاثاء" },
  3: { en: "Wednesday", ar: "الأربعاء" },
  4: { en: "Thursday", ar: "الخميس" },
  5: { en: "Friday", ar: "الجمعة" },
  6: { en: "Saturday", ar: "السبت" },
};

export const getSalesByDayOfWeek: Tool = {
  name: "get_sales_by_day_of_week",
  description:
    "Sales broken down by day-of-week (0=Sunday .. 6=Saturday) in the tenant reporting timezone. Each bucket has revenue, sales count, quantity, English + Arabic label. Also returns the peak day. Use for 'أنهي يوم أحسن؟', 'الجمعة ولا السبت؟', 'best day of week'. Pass `period` preset OR explicit `from`+`to`.",
  requiredPermission: "view_sales",
  parameters: {
    type: "object",
    properties: {
      period: PERIOD_SCHEMA,
      from: DATE_FROM_SCHEMA,
      to: DATE_TO_SCHEMA,
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const resolved = resolveWindow(args);
    const result = await computeSalesByDow(ctx.tenantId, resolved.window);
    return {
      ok: true,
      data: {
        period: resolved.period,
        currency: "EGP",
        timezone: result.timezone,
        window: result.window
          ? {
              from: result.window.from.toISOString(),
              to: result.window.to.toISOString(),
            }
          : null,
        peak: result.peak
          ? { ...result.peak, label: DOW_LABELS[result.peak.dow] }
          : null,
        buckets: result.buckets.map((b) => ({
          ...b,
          label: DOW_LABELS[b.dow],
        })),
      },
    };
  },
};

/* ──────────────────────── get_new_customers ──────────────────────────── */

export const getNewCustomers: Tool = {
  name: "get_new_customers",
  description:
    "Customers whose FIRST-EVER purchase falls inside the window. Storo has no separate customers table — customer identity is `sales.customer_phone`, and 'new customer' means 'first observed sale is within the period'. Use for 'عملاء جدد الشهر ده', 'new customers this month', 'first-time buyers'. Pass `period` preset OR explicit `from`+`to` (required — 'all' is rejected).",
  requiredPermission: "view_customers",
  parameters: {
    type: "object",
    properties: {
      period: PERIOD_SCHEMA,
      from: DATE_FROM_SCHEMA,
      to: DATE_TO_SCHEMA,
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Max customer rows (default 50)." },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const resolved = resolveWindow(args);
    if (!resolved.window) {
      return {
        ok: false,
        error: "RANGE_REQUIRED",
        reason:
          "new_customers needs a concrete window — pick a period other than 'all', or pass from+to.",
      };
    }
    const result = await computeNewCustomers(ctx.tenantId, resolved.window, {
      limit: parseLimit(args.limit, 50, 200),
    });
    return {
      ok: true,
      data: {
        period: resolved.period,
        window: {
          from: result.window.from.toISOString(),
          to: result.window.to.toISOString(),
        },
        count: result.count,
        currency: "EGP",
        customers: result.rows.map((r) => ({
          customerPhone: r.customerPhone,
          customerName: r.customerName,
          firstPurchaseDate: r.firstPurchaseDate.toISOString(),
          firstPurchaseAmount: Math.round(r.firstPurchaseAmount * 100) / 100,
        })),
      },
    };
  },
};

/* ───────────────────── get_inactive_customers ────────────────────────── */

export const getInactiveCustomers: Tool = {
  name: "get_inactive_customers",
  description:
    "Customers with ≥1 lifetime purchase whose LAST purchase is older than `days` (threshold). Never-purchased customers are NOT included (Storo has no customers table — a never-buyer has no sales rows). Use for 'مين مبقاش بيشتري؟', 'customers who haven't bought in 90 days', 'inactive customers'. Describe them as 'inactive for N days', NOT as 'lost' or 'churned' — those claims need a churn model Storo doesn't have.",
  requiredPermission: "view_customers",
  parameters: {
    type: "object",
    properties: {
      days: {
        type: "integer",
        minimum: 1,
        maximum: 3650,
        description: "Inactivity threshold in days (default 60).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        description: "Max customer rows (default 50, sorted oldest-last-purchase first).",
      },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const days = typeof args.days === "number" && args.days > 0 ? Math.floor(args.days) : 60;
    const result = await computeInactiveCustomers(ctx.tenantId, {
      thresholdDays: days,
      limit: parseLimit(args.limit, 50, 200),
    });
    return {
      ok: true,
      data: {
        currency: "EGP",
        thresholdDays: result.thresholdDays,
        count: result.count,
        customers: result.rows.map((r) => ({
          customerPhone: r.customerPhone,
          customerName: r.customerName,
          lastPurchaseDate: r.lastPurchaseDate.toISOString(),
          daysSinceLastPurchase: r.daysSinceLastPurchase,
          lifetimeInvoiceCount: r.lifetimeInvoiceCount,
          lifetimeValue: Math.round(r.lifetimeValue * 100) / 100,
        })),
      },
    };
  },
};

/* ──────────────────── get_supplier_price_history ─────────────────────── */

export const getSupplierPriceHistory: Tool = {
  name: "get_supplier_price_history",
  description:
    "Timeline of unit costs we paid ONE supplier, optionally narrowed to ONE product. Derived from `purchase_order_items.unit_cost` on this supplier's purchase orders. Use for 'حسين كان بيبيعلي الساعة بكام؟', 'did Hussein raise the price?', 'supplier price trend'. When `product_id` is passed the response includes an aggregate (firstCost, latestCost, costDelta, costChangePct) so you can describe the change without summing yourself. Without a product_id the rows span multiple products and the aggregate is null.",
  requiredPermission: "view_purchases",
  parameters: {
    type: "object",
    properties: {
      supplier_id: {
        type: "string",
        minLength: 10,
        description: "Supplier uuid (from find_supplier / resolve_supplier).",
      },
      product_id: {
        type: "string",
        description: "Optional product uuid to scope to one product's cost trend.",
      },
      from: DATE_FROM_SCHEMA,
      to: DATE_TO_SCHEMA,
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        description: "Max PO-item rows (default 50, newest first).",
      },
    },
    required: ["supplier_id"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const supplierId = typeof args.supplier_id === "string" ? args.supplier_id.trim() : "";
    if (!supplierId) return { ok: false, error: "MISSING_SUPPLIER_ID" };
    const productId = typeof args.product_id === "string" && args.product_id.trim() !== ""
      ? args.product_id.trim()
      : null;

    // Date range optional — reuse resolveWindow for consistency, but allow
    // 'all' (which maps to no filter).
    const resolved = resolveWindow({
      ...(typeof args.from === "string" && typeof args.to === "string"
        ? { from: args.from, to: args.to }
        : { period: "all" }),
    });

    const result = await computeSupplierPriceHistory(ctx.tenantId, supplierId, {
      productId,
      from: resolved.window?.from,
      to: resolved.window?.to,
      limit: parseLimit(args.limit, 50, 200),
    });

    return {
      ok: true,
      data: {
        currency: "EGP",
        supplierId: result.supplierId,
        supplierName: result.supplierName,
        productId: result.productId,
        window: {
          from: result.window.from ? result.window.from.toISOString() : null,
          to: result.window.to ? result.window.to.toISOString() : null,
        },
        aggregate: result.aggregate
          ? {
              firstCost: result.aggregate.firstCost,
              firstDate: result.aggregate.firstDate.toISOString(),
              latestCost: result.aggregate.latestCost,
              latestDate: result.aggregate.latestDate.toISOString(),
              costDelta: result.aggregate.costDelta,
              costChangePct: result.aggregate.costChangePct,
              observationCount: result.aggregate.observationCount,
            }
          : null,
        rows: result.rows.map((r) => ({
          purchaseOrderId: r.purchaseOrderId,
          orderDate: r.purchaseOrderOrderDate.toISOString(),
          productId: r.productId,
          productName: r.productName,
          unitCost: r.unitCost,
          quantity: r.quantity,
        })),
      },
    };
  },
};
