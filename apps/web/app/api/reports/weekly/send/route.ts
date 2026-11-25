// QA / cron trigger for the weekly report push.
//
// POST /api/reports/weekly/send
//   Body: { period?: "YYYY-Www" }   — defaults to the ISO week that ended most
//                                      recently (last Monday 00:00 → Sunday).
//
// Fans out `report.weekly` to every eligible tenant member. The mobile tap
// handler then navigates to /reports/weekly?period=<...> and fetches the
// authoritative payload from GET /api/reports/weekly.
//
// Owner-only. Rate-limited to protect against scripted spam.

import { NextRequest, NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { fanoutEvent } from "@/lib/notifications/dispatch";
import { loadInsightsOverview } from "@/lib/repo/insights";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";

function isoWeekOf(date: Date): { period: string; from: Date; to: Date } {
  // ISO 8601: week 1 contains Jan 4th. Week number is the Thursday's.
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const thursday = new Date(d);
  const day = d.getDay() || 7;
  thursday.setDate(d.getDate() + 4 - day);
  const year = thursday.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const week = Math.ceil(((thursday.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
  // Monday of that week.
  const mon = new Date(d);
  mon.setDate(d.getDate() - (day - 1));
  mon.setHours(0, 0, 0, 0);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  sun.setHours(23, 59, 59, 999);
  return { period: `${year}-W${String(week).padStart(2, "0")}`, from: mon, to: sun };
}

function lastClosedWeek(): { period: string; from: Date; to: Date } {
  // Push "last Monday 00:00 → last Sunday 23:59" if today is Mon-Sun this week.
  const now = new Date();
  const day = now.getDay() || 7;
  const lastSunday = new Date(now);
  lastSunday.setDate(now.getDate() - day);
  return isoWeekOf(lastSunday);
}

export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  if (r.ctx.role !== "owner") {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;
  const body = (await req.json().catch(() => ({}))) as { period?: string };
  const week = body.period
    ? (() => {
        // Caller-provided period: re-derive the window (validation lives in the
        // GET route). Here we just need the window to build a preview.
        const [y, w] = body.period.split("-W");
        const d = new Date(Number(y), 0, 4);
        d.setDate(d.getDate() - ((d.getDay() || 7) - 1) + (Number(w) - 1) * 7);
        d.setHours(0, 0, 0, 0);
        const to = new Date(d);
        to.setDate(d.getDate() + 6);
        to.setHours(23, 59, 59, 999);
        return { period: body.period, from: d, to };
      })()
    : lastClosedWeek();

  // Prefetch the headline numbers so the push body shows revenue + sale count
  // on the lock screen. If this throws the fanout continues with nulls. The
  // report always aggregates the whole tenant — Storo has no branches.
  let totalRevenueEgp: number | null = null;
  let salesCount: number | null = null;
  try {
    const ov = await loadInsightsOverview(
      r.ctx.tenantId,
      { from: week.from, to: week.to },
      null,
    );
    totalRevenueEgp = Math.round(ov.metrics.totalRevenue);
    salesCount = ov.metrics.totalSales;
  } catch {
    /* preview numbers are best-effort — dispatch proceeds either way. */
  }

  await fanoutEvent(r.ctx.tenantId, null, "report.weekly", {
    period: week.period,
    totalRevenueEgp,
    salesCount,
    link: `/reports/weekly?period=${encodeURIComponent(week.period)}`,
  });

  return NextResponse.json({ ok: true, period: week.period });
}
