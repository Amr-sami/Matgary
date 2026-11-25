// Monthly structured report. Companion to /api/reports/weekly — same shape,
// different period. See weekly/route.ts for the design notes.
//
// GET /api/reports/monthly?period=YYYY-MM

import { NextRequest, NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { loadInsightsOverview } from "@/lib/repo/insights";

/** Parse `YYYY-MM`. Returns the month's first day 00:00 and last day 23:59. */
function parseMonth(period: string): { from: Date; to: Date; year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(period.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const from = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const to = new Date(year, month, 0, 23, 59, 59, 999); // day 0 of next month = last day of this one
  return { from, to, year, month };
}

export async function GET(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const period = req.nextUrl.searchParams.get("period");
  if (!period) {
    return NextResponse.json({ error: "period required (YYYY-MM)" }, { status: 400 });
  }
  const parsed = parseMonth(period);
  if (!parsed) {
    return NextResponse.json({ error: "INVALID_PERIOD" }, { status: 400 });
  }
  // Storo has no branch concept in reports. Pass null so
  // loadInsightsOverview aggregates every row in the tenant.
  const overview = await loadInsightsOverview(
    r.ctx.tenantId,
    { from: parsed.from, to: parsed.to },
    null,
  );
  return NextResponse.json({
    kind: "monthly",
    period,
    window: {
      from: parsed.from.toISOString(),
      to: parsed.to.toISOString(),
      year: parsed.year,
      month: parsed.month,
    },
    overview,
  });
}
