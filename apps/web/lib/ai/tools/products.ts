import { listProductHistory } from "@/lib/repo/catalog";

import { resolveProducts } from "../resolve/products";

import type { Tool } from "./types";
import { DATE_FROM_SCHEMA, DATE_TO_SCHEMA, parseLimit, resolveWindow } from "./_shared";

/**
 * Product query tools — the ONLY path through which the agent is allowed to
 * speak about product existence, prices or stock. The F-plan §3 is explicit:
 * Gemini must never answer product questions from pretrained knowledge.
 *
 * Every result carries a `source` block (F-plan §9). The grounding guard
 * downstream uses this to classify any later business claim the model makes
 * as either FACT, DERIVED, INFERENCE or UNKNOWN.
 */

/* --------------------------------------------------- search_products */

export const searchProducts: Tool = {
  name: "search_products",
  description:
    "Search the store's REAL product catalog by name (Arabic or English), brand, SKU or barcode. ALWAYS call this before mentioning any product's existence, price or stock. Returns ranked matches with a confidence tier (HIGH / MEDIUM / LOW / NONE). HIGH → answer with that product. MEDIUM / LOW with multiple candidates → ask the user which one. NONE → tell the user no match was found; NEVER invent a product.",
  requiredPermission: "view_inventory",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        description: "What the user typed — product name, brand, SKU or barcode. Arabic and English both work.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Max candidates to return (default 5).",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const query = typeof args.query === "string" ? args.query : "";
    const limit = parseLimit(args.limit, 5, 20);
    const res = await resolveProducts(
      { tenantId: ctx.tenantId, branchId: null, query },
      { limit },
    );
    return {
      ok: true,
      data: {
        query: res.query,
        totalScanned: res.totalScanned,
        topTier: res.topTier,
        candidates: res.candidates.map(toApi),
        // Source metadata — never user-visible; used by grounding + logs.
        _source: res.source,
      },
    };
  },
};

/* --------------------------------------------------- get_product */

export const getProduct: Tool = {
  name: "get_product",
  description:
    "Fetch ONE product by its exact id (uuid). Use this after search_products returned a HIGH-confidence candidate the user just selected. Returns authoritative price, stock, brand and SKU from the store database.",
  requiredPermission: "view_inventory",
  parameters: {
    type: "object",
    properties: {
      product_id: {
        type: "string",
        description: "The product's uuid as returned by search_products.",
      },
    },
    required: ["product_id"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const id = typeof args.product_id === "string" ? args.product_id : "";
    if (!id) return { ok: false, error: "MISSING_PRODUCT_ID" };
    // Simplest: re-run resolver with the id as query against SKU/name — not
    // ideal. Prefer a direct id lookup. We use listProducts + filter to avoid
    // adding a new repo helper this wave; listProducts is cached per request.
    const res = await resolveProducts(
      { tenantId: ctx.tenantId, branchId: null, query: "" },
      { limit: 10_000, minScore: 0 }, // get everything
    );
    const hit = res.candidates.find((c) => c.id === id);
    if (!hit) return { ok: false, error: "NOT_FOUND", reason: `No product ${id} in current scope` };
    return {
      ok: true,
      data: {
        product: toApi(hit),
        _source: res.source,
      },
    };
  },
};

/* --------------------------------------------------- get_product_sales_history */

/**
 * Per-product history slice — answers "how many times was X sold?", "when was
 * X last sold?", "show me sales of this watch this month". Wraps the
 * authoritative `listProductHistory` repo helper (products.ts:755 in catalog)
 * and filters its rows by the resolved window + requested event types.
 *
 * NEVER derived — only rows the ledger already recorded are returned.
 */
export const getProductSalesHistory: Tool = {
  name: "get_product_sales_history",
  description:
    "Ledger of sale/return events for ONE product, newest first. Use for 'how many times was this product sold?', 'show me sales of X this month', 'when was X last sold?'. Pass a `period` preset OR an explicit `from`+`to` ISO day pair. Returns events with type ('sold' | 'returned' | 'restocked' | 'decreased' | 'updated' | 'created'), delta, running quantityAfter, and createdAt. Also aggregates sold/returned totals in the window.",
  requiredPermission: "view_sales",
  parameters: {
    type: "object",
    properties: {
      product_id: {
        type: "string",
        description: "The product's uuid as returned by search_products / get_product.",
      },
      period: {
        type: "string",
        enum: ["today", "yesterday", "week", "month", "quarter", "year", "all"],
        description:
          "Optional preset. Defaults to 'all' (lifetime of the product) when neither period nor from/to is passed.",
      },
      from: DATE_FROM_SCHEMA,
      to: DATE_TO_SCHEMA,
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Max event rows to return (default 25).",
      },
      only_sales: {
        type: "boolean",
        description:
          "When true, filter rows to type='sold' OR type='returned' only (default true — pure sales history). Set false to include stock adjustments and catalog edits too.",
      },
    },
    required: ["product_id"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const productId = typeof args.product_id === "string" ? args.product_id.trim() : "";
    if (!productId) return { ok: false, error: "MISSING_PRODUCT_ID" };

    const limit = parseLimit(args.limit, 25, 100);
    const resolved = resolveWindow(args);
    const onlySales = args.only_sales === false ? false : true;

    const all = await listProductHistory(ctx.tenantId, productId);
    const w = resolved.window;

    const typeFilter = (t: string) =>
      onlySales ? t === "sold" || t === "returned" : true;

    const windowed = all.filter((row) => {
      if (!typeFilter(row.type)) return false;
      if (!w) return true;
      return row.createdAt >= w.from && row.createdAt <= w.to;
    });

    let soldQty = 0;
    let returnedQty = 0;
    for (const row of windowed) {
      if (row.type === "sold") soldQty += Math.abs(row.delta ?? 0);
      else if (row.type === "returned") returnedQty += Math.abs(row.delta ?? 0);
    }

    const rows = windowed.slice(0, limit).map((row) => ({
      id: row.id,
      type: row.type,
      delta: row.delta ?? null,
      quantityAfter: row.quantityAfter ?? null,
      note: row.note ?? null,
      createdAt: row.createdAt.toISOString(),
    }));

    return {
      ok: true,
      data: {
        productId,
        productName: all[0]?.productName ?? null,
        period: resolved.period,
        window: w
          ? { from: w.from.toISOString(), to: w.to.toISOString() }
          : null,
        totals: {
          soldQuantity: soldQty,
          returnedQuantity: returnedQty,
          netSoldQuantity: soldQty - returnedQty,
          eventCount: windowed.length,
        },
        rows,
      },
    };
  },
};

/* --------------------------------------------------- shape */

function toApi(p: {
  id: string;
  name: string;
  brand: string | null;
  sku: string | null;
  price: number;
  costPrice: number | null;
  quantity: number;
  lowStockThreshold: number;
  score: number;
  tier: string;
  matchedOn: string[];
}) {
  return {
    id: p.id,
    name: p.name,
    brand: p.brand,
    sku: p.sku,
    price: p.price,
    quantity: p.quantity,
    lowStockThreshold: p.lowStockThreshold,
    currency: "EGP" as const,
    inStock: p.quantity > 0,
    lowStock: p.quantity > 0 && p.quantity <= p.lowStockThreshold,
    outOfStock: p.quantity === 0,
    // Match diagnostics the model can use to decide ambiguity.
    confidence: {
      score: Math.round(p.score * 100) / 100,
      tier: p.tier,
      matchedOn: p.matchedOn,
    },
  };
}
