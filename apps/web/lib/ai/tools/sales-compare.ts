import { loadCompareReport } from "@/lib/repo/insights-deep";

import type { Tool } from "./types";
import {
  DATE_FROM_SCHEMA,
  DATE_TO_SCHEMA,
  PERIOD_SCHEMA,
  resolveWindow,
} from "./_shared";

/**
 * Period-vs-previous-period sales comparison.
 *
 * The authoritative `loadCompareReport(tenantId, window)` already computes the
 * matching prior window (same length, immediately preceding), the per-day
 * series for both windows, and the growth %. This tool only resolves the
 * input window and returns the engine's result — no business logic in the
 * Agent layer.
 */
export const getSalesComparison: Tool = {
  name: "get_sales_comparison",
  description:
    "Compare sales in a target period against the matching prior period of the same length. Use for 'this month vs last month', 'this week vs last week', 'did sales improve'. Pass `period` preset OR explicit `from`+`to`. Returns current total, previous total, growth %, and a day-aligned series. The prior window is auto-computed — do NOT pass it.",
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
    const w = resolved.window;
    if (!w) {
      return {
        ok: false,
        error: "RANGE_REQUIRED",
        reason:
          "Comparison needs a concrete window — pick a period other than 'all', or pass from+to.",
      };
    }
    const report = await loadCompareReport(ctx.tenantId, w, null);
    return {
      ok: true,
      data: {
        period: resolved.period,
        currency: "EGP",
        window: report.window,
        previousWindow: report.previousWindow,
        totals: report.totals,
        points: report.points,
      },
    };
  },
};
