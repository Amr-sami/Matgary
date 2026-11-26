// GET /api/financials/profitability/products — product profitability.
// Requires view_financials AND view_profit (profit numbers are redacted
// otherwise). Uses historical costPriceAtSale snapshot.

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
import { computeProductProfitability } from "@/lib/finance/profitability";

const querySchema = z.object({
  preset: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  search: z.string().max(200).optional(),
  sort: z.enum(["revenue", "grossProfit", "margin", "quantity"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export async function GET(req: NextRequest) {
  const r = await requirePermission("view_financials");
  if (!r.ok) return r.response;

  const parsed = querySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }
  const q = parsed.data;
  const preset: DatePresetKey = isDatePresetKey(q.preset)
    ? q.preset
    : q.from && q.to
      ? "custom"
      : "this_month";
  const period = resolvePreset(preset, {
    tz: DEFAULT_REPORTING_TZ,
    customFrom: q.from,
    customTo: q.to,
  });

  const { rows, total } = await computeProductProfitability(r.ctx.tenantId, period, {
    search: q.search,
    sort: q.sort,
    limit: q.limit,
    offset: q.offset,
  });

  // view_profit redaction: hide cogs/grossProfit/margin from callers that
  // only hold view_financials. Revenue + units sold remain visible so a
  // store manager who tracks spend but not margin is still useful.
  const seesProfit = can(r.ctx, "view_profit");
  const safeRows = seesProfit
    ? rows
    : rows.map((row) => ({
        ...row,
        cogs: null,
        grossProfit: null,
        margin: null,
      }));

  return NextResponse.json({
    data: safeRows,
    total,
    seesProfit,
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
  });
}
