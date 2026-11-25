// GET /api/financials/pnl — the full Profit & Loss statement for a period.
//
// Same engine as /overview, different response shape. This endpoint carries
// the full hierarchy (OpEx by group → subcategory) so the UI can render the
// expandable P&L tree without a second call.
//
// Two permission gates:
//   • `view_financials` — required to see the P&L at all.
//   • `view_profit` — required to see gross/operating/net profit figures and
//     margins. Without it, profit lines are nulled out but revenue + expenses
//     remain visible (a store manager who tracks spend but isn't trusted
//     with margin data is still useful).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/api/auth-helpers";
import { can } from "@/lib/permissions";
import {
  DEFAULT_REPORTING_TZ,
  isDatePresetKey,
  resolvePreset,
  type DatePresetKey,
} from "@/lib/finance/dates";
import {
  computePnLFromSource,
  fetchPnLSource,
} from "@/lib/finance/pnl";

const querySchema = z.object({
  preset: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export async function GET(req: NextRequest) {
  // Enforced — no audit ramp on new permission keys.
  const r = await requirePermission("view_financials");
  if (!r.ok) return r.response;

  const parsed = querySchema.safeParse({
    preset: req.nextUrl.searchParams.get("preset") ?? undefined,
    from: req.nextUrl.searchParams.get("from") ?? undefined,
    to: req.nextUrl.searchParams.get("to") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  const preset: DatePresetKey = isDatePresetKey(parsed.data.preset)
    ? parsed.data.preset
    : parsed.data.from && parsed.data.to
      ? "custom"
      : "this_month";

  const period = resolvePreset(preset, {
    tz: DEFAULT_REPORTING_TZ,
    customFrom: parsed.data.from,
    customTo: parsed.data.to,
  });

  const source = await fetchPnLSource(r.ctx.tenantId, period);
  const pnl = computePnLFromSource(source);

  const seesProfit = can(r.ctx, "view_profit");

  // If the caller may not see profit, redact the derived profit/margin
  // figures but keep revenue + expenses visible. The breakdown rows
  // themselves don't reveal margin (they are category amounts).
  const payload = seesProfit
    ? pnl
    : {
        ...pnl,
        grossProfit: null,
        operatingProfit: null,
        netProfit: null,
        grossMargin: null,
        netMargin: null,
      };

  return NextResponse.json({
    data: payload,
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
    preset,
    seesProfit,
    movements: source.moneyMovements,
  });
}
