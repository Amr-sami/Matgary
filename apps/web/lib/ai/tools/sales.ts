import { loadInsightsOverview } from "@/lib/repo/insights";

import type { Tool } from "./types";
import {
  DATE_FROM_SCHEMA,
  DATE_TO_SCHEMA,
  PERIOD_SCHEMA,
  resolveWindow,
} from "./_shared";
import { redactProfitOnRow, redactProfitOnRows, seesProfit } from "./_profit";

/** Dashboard headline (revenue, growth, profit, discounts, sales, returns)
 *  plus the top 5 products of the window. Accepts either a `period` preset
 *  or an explicit `from`/`to` ISO day pair (custom wins when both passed). */
export const getSalesOverview: Tool = {
  name: "get_sales_overview",
  description:
    "Dashboard headline for the shop over a period — revenue, growth vs previous period, net profit, discounts, sales count, returns. Also returns the top 5 selling products of the window. Pass a `period` preset OR an explicit `from`+`to` ISO day pair (yyyy-mm-dd) for arbitrary ranges like 'from 1 October to 15 October'.",
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
    const data = await loadInsightsOverview(ctx.tenantId, resolved.window, null);
    // view_profit enforcement — the legacy insights repo doesn't redact, so
    // the Agent layer does. Mutates a shallow copy so cached data isn't
    // affected; `seesProfit: false` tells the model the field is hidden on
    // purpose (don't invent one).
    const permit = seesProfit(ctx);
    const metrics = permit
      ? data.metrics
      : redactProfitOnRow({ ...(data.metrics as unknown as Record<string, unknown>) });
    const topProducts = permit
      ? data.topProducts.slice(0, 5)
      : redactProfitOnRows(
          data.topProducts
            .slice(0, 5)
            .map((p) => ({ ...(p as unknown as Record<string, unknown>) })),
        );
    return {
      ok: true,
      data: {
        period: resolved.period,
        window: resolved.window
          ? {
              from: resolved.window.from.toISOString(),
              to: resolved.window.to.toISOString(),
            }
          : null,
        currency: "EGP",
        seesProfit: permit,
        metrics,
        topProducts,
      },
    };
  },
};

/** Day-by-day revenue + sales count for a period. */
export const getSalesTrend: Tool = {
  name: "get_sales_trend",
  description:
    "Day-by-day revenue + sales count for a period so you can describe whether the shop is trending up, flat or down. Pass a `period` preset OR an explicit `from`+`to` ISO day pair for arbitrary ranges.",
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
    const data = await loadInsightsOverview(ctx.tenantId, resolved.window, null);
    return {
      ok: true,
      data: {
        period: resolved.period,
        window: resolved.window
          ? {
              from: resolved.window.from.toISOString(),
              to: resolved.window.to.toISOString(),
            }
          : null,
        currency: "EGP",
        totalRevenue: data.metrics.totalRevenue,
        totalSales: data.metrics.totalSales,
        daily: data.trendData,
      },
    };
  },
};
