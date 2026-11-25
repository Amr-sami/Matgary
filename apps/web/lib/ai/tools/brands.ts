import { loadBrandBreakdown } from "@/lib/repo/insights-deep";

import type { Tool } from "./types";
import { PERIOD_SCHEMA, parseLimit, parsePeriod, windowFor } from "./_shared";
import { redactProfitOnRow, redactProfitOnRows, seesProfit } from "./_profit";

export const getTopBrands: Tool = {
  name: "get_top_brands",
  description:
    "Brand-level breakdown over a period: revenue, cost, gross profit, margin, units, transactions, AOV, discounts, and store/online channel split per brand. Use for 'top brand', 'which brand sells best', 'brand P&L'.",
  parameters: {
    type: "object",
    properties: {
      period: PERIOD_SCHEMA,
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 30,
        description: "Max brands to return (default 10).",
      },
    },
    required: ["period"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const period = parsePeriod(args.period);
    const limit = parseLimit(args.limit, 10, 30);
    const w = windowFor(period);
    const data = await loadBrandBreakdown(ctx.tenantId, w, null);
    // view_profit enforcement — brand rows expose cost / grossProfit / margin
    // so an employee without view_profit must get them nulled.
    const permit = seesProfit(ctx);
    const totals = permit
      ? data.totals
      : redactProfitOnRow({ ...(data.totals as unknown as Record<string, unknown>) });
    const sliced = data.rows.slice(0, limit);
    const rows = permit
      ? sliced
      : redactProfitOnRows(sliced.map((r) => ({ ...(r as unknown as Record<string, unknown>) })));
    return {
      ok: true,
      data: {
        period,
        currency: "EGP",
        seesProfit: permit,
        totals,
        rows,
      },
    };
  },
};
