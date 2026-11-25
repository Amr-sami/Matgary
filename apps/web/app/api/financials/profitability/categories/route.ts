// GET /api/financials/profitability/categories — category profitability.

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
import { computeCategoryProfitability } from "@/lib/finance/profitability";

const querySchema = z.object({
  preset: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  sort: z.enum(["revenue", "grossProfit", "margin", "quantity"]).optional(),
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

  const rows = await computeCategoryProfitability(r.ctx.tenantId, period, {
    sort: q.sort,
  });

  const seesProfit = can(r.ctx, "view_profit");
  const safeRows = seesProfit
    ? rows
    : rows.map((row) => ({ ...row, cogs: null, grossProfit: null, margin: null }));

  return NextResponse.json({
    data: safeRows,
    seesProfit,
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
  });
}
