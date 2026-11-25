// Shared `view_profit` redaction helpers for AI tools.
//
// The Financials engine (`lib/finance/pnl.ts`, `profitability.ts`, `trends.ts`)
// already blanks profit / margin / cost fields when the caller lacks
// `view_profit`. The LEGACY insight tools (`get_sales_overview`,
// `get_top_brands`) call `loadInsightsOverview` / `loadBrandBreakdown` which
// have NO such redaction, so an employee with `view_insights` but NOT
// `view_profit` could ask the Agent "what's today's net profit?" and get a
// real number — this helper closes that leak without reorganising the repo
// layer.
//
// Contract:
//   - owner ALWAYS sees everything (matches the orchestrator's existing owner
//     bypass in `tools/index.ts`).
//   - `view_profit` holders see everything.
//   - everyone else gets `null` for profit / margin / cost fields.
//
// The tool still returns the row; only the restricted fields are blanked. A
// `seesProfit: false` sibling tells the model it was redacted so it can tell
// the user "your permission doesn't include profit" instead of inventing one.

import type { ToolContext } from "../context";

export function seesProfit(ctx: ToolContext): boolean {
  return ctx.role === "owner" || ctx.permissions.includes("view_profit");
}

/** Null out every profit-ish key on a plain object. Mutates in place; returns
 *  the same reference for chaining. Keys covered: anything the existing
 *  insights repos can expose: netProfit, grossProfit, operatingProfit, margin,
 *  marginPct, grossMargin, netMargin, cost, totalCost, costOfGoodsSold, cogs,
 *  profit. */
const PROFIT_FIELDS = [
  "netProfit",
  "grossProfit",
  "operatingProfit",
  "profit",
  "margin",
  "marginPct",
  "grossMargin",
  "netMargin",
  "cost",
  "totalCost",
  "costOfGoodsSold",
  "cogs",
] as const;

export function redactProfitOnRow<T extends Record<string, unknown>>(row: T): T {
  for (const key of PROFIT_FIELDS) {
    if (key in row) (row as Record<string, unknown>)[key] = null;
  }
  return row;
}

export function redactProfitOnRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  for (const r of rows) redactProfitOnRow(r);
  return rows;
}
