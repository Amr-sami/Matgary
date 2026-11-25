import { loadPaymentMixReport } from "@/lib/repo/insights-deep";

import type { Tool } from "./types";
import {
  DATE_FROM_SCHEMA,
  DATE_TO_SCHEMA,
  PERIOD_SCHEMA,
  resolveWindow,
} from "./_shared";

export const getPaymentMix: Tool = {
  name: "get_payment_mix",
  description:
    "Totals per payment method (cash, instapay, wallet, card, deferred) over a period. Use when the user asks about payment preferences, cash share, deferred/credit sales. Pass a `period` preset OR an explicit `from`+`to` ISO day pair.",
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
    const data = await loadPaymentMixReport(ctx.tenantId, resolved.window, null);
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
        totals: data.totals,
        methods: data.methods,
      },
    };
  },
};
