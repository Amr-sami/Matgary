// Agent tools that connect the existing Financials engine.
//
// Zero new accounting logic lives in these tools — they are read-through
// wrappers over `lib/finance/pnl.ts`, `lib/finance/profitability.ts` and
// `lib/finance/trends.ts`. Every tool:
//   1. Parses the period (preset + optional custom from/to).
//   2. Calls the authoritative engine with `ctx.tenantId` only.
//   3. Applies view_profit redaction — mirrors the HTTP routes under
//      /api/financials/* that already do this.
//
// The Agent is told (via the system prompt's accounting-rules section) to
// reach for THESE tools for any financial number instead of recomputing from
// sale rows via get_sales_overview / get_top_brands.

import {
  DEFAULT_REPORTING_TZ,
  isDatePresetKey,
  resolvePreset,
  type DatePresetKey,
} from "@/lib/finance/dates";
import { computePnL, fetchPnLSource, overviewFromPnl } from "@/lib/finance/pnl";
import {
  computeCategoryProfitability,
  computeProductProfitability,
} from "@/lib/finance/profitability";
import { autoBucketFor, computeTrend, type TrendBucket } from "@/lib/finance/trends";

import type { Tool } from "./types";
import { seesProfit } from "./_profit";

/* ──────────────────────────── shared parameter ─────────────────────────── */

const PRESET_ENUM = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "this_year",
  "last_7_days",
  "last_30_days",
  "custom",
] as const;

const PRESET_SCHEMA = {
  type: "string",
  enum: PRESET_ENUM,
  description:
    "Date preset. 'custom' requires `from` + `to` ISO days ('YYYY-MM-DD'). Defaults to 'this_month' if the model forgets.",
} as const;

const DATE_ISO = {
  type: "string",
  description: "Calendar day 'YYYY-MM-DD'. Required when preset is 'custom'.",
} as const;

function parsePreset(v: unknown): DatePresetKey {
  return isDatePresetKey(v) ? v : "this_month";
}

function resolve(
  presetArg: unknown,
  fromArg: unknown,
  toArg: unknown,
) {
  const preset = parsePreset(presetArg);
  const customFrom = typeof fromArg === "string" ? fromArg : undefined;
  const customTo = typeof toArg === "string" ? toArg : undefined;
  return {
    preset,
    period: resolvePreset(preset, {
      tz: DEFAULT_REPORTING_TZ,
      customFrom,
      customTo,
    }),
  };
}

/* ─────────────────────── get_financials_overview ───────────────────────── */

export const getFinancialsOverview: Tool = {
  name: "get_financials_overview",
  description:
    "Authoritative Financials headline over a period — gross sales, discounts, returns, net sales, COGS, gross profit, operating expenses, operating profit, other income/expense, net profit, margins, money-in/out. Backed by the live P&L engine (lib/finance/pnl.ts). Honors view_profit (nulls profit + margin fields for callers without the permission). Use this whenever the user asks for financial numbers — do NOT recompute from sale rows.",
  requiredPermission: "view_financials",
  parameters: {
    type: "object",
    properties: {
      preset: PRESET_SCHEMA,
      from: DATE_ISO,
      to: DATE_ISO,
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const { preset, period } = resolve(args.preset, args.from, args.to);
    const source = await fetchPnLSource(ctx.tenantId, period);
    const pnl = (await import("@/lib/finance/pnl")).computePnLFromSource(source);
    const overview = overviewFromPnl(
      pnl,
      period,
      source.sales.length,
      source.returns.length,
      source.moneyMovements,
    );
    const permit = seesProfit(ctx);
    const safe = permit
      ? overview
      : {
          ...overview,
          cogs: null as unknown as number,
          grossProfit: null as unknown as number,
          grossMargin: null as unknown as number,
          operatingProfit: null as unknown as number,
          netProfit: null as unknown as number,
          netMargin: null as unknown as number,
        };
    return {
      ok: true,
      data: {
        preset,
        currency: "EGP",
        seesProfit: permit,
        overview: safe,
      },
    };
  },
};

/* ────────────────────────────── get_pnl ────────────────────────────────── */

export const getPnL: Tool = {
  name: "get_pnl",
  description:
    "Full hierarchical Profit & Loss statement for a period — revenue ladder, COGS, operating expenses broken down by group, operating profit, other income/expense, net profit and margins. Backed by lib/finance/pnl.ts (same source the web P&L page uses). Honors view_profit.",
  requiredPermission: "view_financials",
  parameters: {
    type: "object",
    properties: {
      preset: PRESET_SCHEMA,
      from: DATE_ISO,
      to: DATE_ISO,
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const { preset, period } = resolve(args.preset, args.from, args.to);
    const pnl = await computePnL(ctx.tenantId, period);
    const permit = seesProfit(ctx);
    const safe = permit
      ? pnl
      : {
          ...pnl,
          grossProfit: null,
          grossMargin: null,
          operatingProfit: null,
          netProfit: null,
          netMargin: null,
        };
    return {
      ok: true,
      data: {
        preset,
        currency: "EGP",
        seesProfit: permit,
        pnl: safe,
      },
    };
  },
};

/* ──────────────────── get_product_profitability ───────────────────────── */

export const getProductProfitability: Tool = {
  name: "get_product_profitability",
  description:
    "Per-product profitability — quantity sold, revenue, COGS (historical costPriceAtSale), gross profit, margin. Backed by lib/finance/profitability.ts; returns rows in the server-chosen sort order (revenue by default). Honors view_profit.",
  requiredPermission: "view_financials",
  parameters: {
    type: "object",
    properties: {
      preset: PRESET_SCHEMA,
      from: DATE_ISO,
      to: DATE_ISO,
      search: { type: "string", description: "Filter products by name/SKU." },
      sort: {
        type: "string",
        enum: ["revenue", "grossProfit", "margin", "quantity"],
        description: "Sort key. Defaults to 'revenue'.",
      },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const { preset, period } = resolve(args.preset, args.from, args.to);
    const sort = (args.sort === "grossProfit" || args.sort === "margin" || args.sort === "quantity")
      ? (args.sort as "grossProfit" | "margin" | "quantity")
      : "revenue";
    const limit = typeof args.limit === "number" ? Math.min(Math.max(1, Math.floor(args.limit)), 100) : 20;
    const search = typeof args.search === "string" ? args.search : undefined;
    const { rows, total } = await computeProductProfitability(ctx.tenantId, period, {
      search,
      sort,
      limit,
      offset: 0,
    });
    const permit = seesProfit(ctx);
    const safeRows = permit
      ? rows
      : rows.map((r) => ({ ...r, cogs: null, grossProfit: null, margin: null }));
    return {
      ok: true,
      data: {
        preset,
        currency: "EGP",
        seesProfit: permit,
        total,
        rows: safeRows,
      },
    };
  },
};

/* ──────────────────── get_category_profitability ──────────────────────── */

export const getCategoryProfitability: Tool = {
  name: "get_category_profitability",
  description:
    "Per-category profitability — quantity sold, revenue, COGS, gross profit, margin per product category. Backed by lib/finance/profitability.ts. Honors view_profit.",
  requiredPermission: "view_financials",
  parameters: {
    type: "object",
    properties: {
      preset: PRESET_SCHEMA,
      from: DATE_ISO,
      to: DATE_ISO,
      sort: {
        type: "string",
        enum: ["revenue", "grossProfit", "margin", "quantity"],
      },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const { preset, period } = resolve(args.preset, args.from, args.to);
    const sort = (args.sort === "grossProfit" || args.sort === "margin" || args.sort === "quantity")
      ? (args.sort as "grossProfit" | "margin" | "quantity")
      : "revenue";
    const rows = await computeCategoryProfitability(ctx.tenantId, period, { sort });
    const permit = seesProfit(ctx);
    const safeRows = permit
      ? rows
      : rows.map((r) => ({ ...r, cogs: null, grossProfit: null, margin: null }));
    return {
      ok: true,
      data: {
        preset,
        currency: "EGP",
        seesProfit: permit,
        rows: safeRows,
      },
    };
  },
};

/* ────────────────────────── get_financial_trends ───────────────────────── */

export const getFinancialTrends: Tool = {
  name: "get_financial_trends",
  description:
    "Dense (zero-filled) financial time-series for a period — revenue, net sales, COGS, gross profit, operating expenses, operating profit, net profit per bucket (day/week/month). Backed by lib/finance/trends.ts. Honors view_profit (blanks profit fields when not permitted). Perfect feed for render_chart.",
  requiredPermission: "view_financials",
  parameters: {
    type: "object",
    properties: {
      preset: PRESET_SCHEMA,
      from: DATE_ISO,
      to: DATE_ISO,
      bucket: { type: "string", enum: ["day", "week", "month"] },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const { preset, period } = resolve(args.preset, args.from, args.to);
    const bucket: TrendBucket | undefined =
      args.bucket === "day" || args.bucket === "week" || args.bucket === "month"
        ? (args.bucket as TrendBucket)
        : undefined;
    const { bucket: resolvedBucket, data } = await computeTrend(ctx.tenantId, period, bucket);
    const permit = seesProfit(ctx);
    const safe = permit
      ? data
      : data.map((d) => ({
          ...d,
          cogs: null,
          grossProfit: null,
          operatingProfit: null,
          netProfit: null,
        }));
    return {
      ok: true,
      data: {
        preset,
        bucket: resolvedBucket ?? autoBucketFor(period),
        currency: "EGP",
        seesProfit: permit,
        points: safe,
      },
    };
  },
};
