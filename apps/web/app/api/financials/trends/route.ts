// GET /api/financials/trends — time-series data for Financials charts.
// Each point carries revenue, discounts, returns, COGS, OpEx, net profit.
// Profit-sensitive columns are nulled out for view_profit=false callers.

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
import { computeTrend } from "@/lib/finance/trends";

const querySchema = z.object({
  preset: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  bucket: z.enum(["day", "week", "month"]).optional(),
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

  const { bucket, data } = await computeTrend(r.ctx.tenantId, period, q.bucket);
  const seesProfit = can(r.ctx, "view_profit");

  const safeData = seesProfit
    ? data
    : data.map((p) => ({
        ...p,
        cogs: null,
        grossProfit: null,
        operatingProfit: null,
        netProfit: null,
      }));

  return NextResponse.json({
    bucket,
    data: safeData,
    seesProfit,
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
  });
}
