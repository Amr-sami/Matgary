// Weekly structured report.
//
// GET /api/reports/weekly?period=YYYY-Www (ISO week, Monday-start)
//   Returns the authoritative report payload for the given ISO week — the
//   push notification carries only the period id, so the mobile report screen
//   fetches this endpoint on tap to always reflect the latest DB state.
//
// Reuses `loadInsightsOverview` so the numbers are the same the dashboard
// shows for the same window. Report rendering (KPI cards, top products) lives
// on the mobile client.

import { NextRequest, NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { loadInsightsOverview } from "@/lib/repo/insights";

/** Parse `YYYY-Www` (ISO 8601 week-date). Returns the week's Monday 00:00
 *  and Sunday 23:59:59.999 in the server's local timezone. */
function parseIsoWeek(period: string): { from: Date; to: Date; year: number; week: number } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(period.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  // ISO week 1 is the week containing Jan 4th. Find that Monday and add
  // (week - 1) weeks. Reference: ISO 8601 §5.2.3.
  const jan4 = new Date(year, 0, 4);
  const jan4Dow = jan4.getDay() || 7; // Sunday=0 → 7 (ISO)
  const week1Mon = new Date(jan4);
  week1Mon.setDate(jan4.getDate() - (jan4Dow - 1));
  const from = new Date(week1Mon);
  from.setDate(week1Mon.getDate() + (week - 1) * 7);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(from.getDate() + 6);
  to.setHours(23, 59, 59, 999);
  return { from, to, year, week };
}

export async function GET(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const period = req.nextUrl.searchParams.get("period");
  if (!period) {
    return NextResponse.json({ error: "period required (YYYY-Www)" }, { status: 400 });
  }
  const parsed = parseIsoWeek(period);
  if (!parsed) {
    return NextResponse.json({ error: "INVALID_PERIOD" }, { status: 400 });
  }
  // Storo has no branch concept in reports. Pass null so
  // loadInsightsOverview aggregates every row in the tenant — matching the
  // report cron and the mental model the user holds.
  const overview = await loadInsightsOverview(
    r.ctx.tenantId,
    { from: parsed.from, to: parsed.to },
    null,
  );
  return NextResponse.json({
    kind: "weekly",
    period,
    window: {
      from: parsed.from.toISOString(),
      to: parsed.to.toISOString(),
      year: parsed.year,
      week: parsed.week,
    },
    overview,
  });
}
