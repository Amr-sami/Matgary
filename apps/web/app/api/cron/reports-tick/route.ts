// Scheduled reports tick.
//
// External scheduler calls this every hour. For each non-suspended tenant we
// read its local time from the DB (`now() at time zone tenants.timezone`,
// same pattern as cron/digest-tick/route.ts) and fire:
//
//   - `report.weekly`  when local DOW=Mon AND hour=08
//   - `report.monthly` when local day=1    AND hour=08
//
// Idempotency: `wasAlreadyDispatched` matches on
// (tenant, ownerUserId, kind=report, link="/reports/<kind>?period=...", created_at>=period_start).
// A duplicate hour-tick sees the previously-written notification row and
// skips; a fresh period passes through.
//
// No branch filter — Storo has no branches in the notification architecture.
// The reports repo already computes the figures tenant-wide (legacy
// multi-branch tables still accept a null branch filter via
// resolveBranchFilter).

import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { tenantReportSettings, tenants } from "@/lib/db/schema";
import { guardCronRequest } from "@/lib/cron/auth";
import { fanoutEvent } from "@/lib/notifications/dispatch";
import { loadInsightsOverview } from "@/lib/repo/insights";
import { listOwnerUserIds, wasAlreadyDispatched } from "@/lib/notifications/dedupe";
import { logger } from "@/lib/logger";

/** Defaults when a tenant has no tenant_report_settings row yet. These
 *  match the row's column defaults verbatim so the behavior is identical
 *  with or without an explicit row. "On by default" per Notification Center
 *  spec §4: owners shouldn't have to turn on standard operational reports. */
const DEFAULT_REPORT_CONFIG = {
  dailyEnabled: true,
  dailyHour: 21,
  dailyMinute: 0,
  weeklyEnabled: true,
  weeklyDow: 0, // Sunday
  weeklyHour: 9,
  weeklyMinute: 0,
  monthlyEnabled: true,
  monthlyDay: 1,
  monthlyHour: 9,
  monthlyMinute: 0,
} as const;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LocalTime {
  hour: number;
  minute: number;
  /** ISO DOW: 1=Mon .. 7=Sun. The tenant_report_settings.weekly_dow uses
   *  Sun=0..Sat=6 (JS convention) — translate when comparing. */
  dow: number;
  /** JS-style DOW: 0=Sun..6=Sat. Mirrors tenant_report_settings.weekly_dow. */
  jsDow: number;
  day: number;
  year: number;
  month: number;
  week: number;
}

async function localTime(tz: string): Promise<LocalTime | null> {
  const rows = (await db.execute(sql`
    select extract(hour from (now() at time zone ${tz}))::int as hour,
           extract(minute from (now() at time zone ${tz}))::int as minute,
           extract(isodow from (now() at time zone ${tz}))::int as dow,
           extract(dow from (now() at time zone ${tz}))::int as "jsDow",
           extract(day from (now() at time zone ${tz}))::int as day,
           extract(isoyear from (now() at time zone ${tz}))::int as year,
           extract(month from (now() at time zone ${tz}))::int as month,
           extract(week from (now() at time zone ${tz}))::int as week
  `)) as unknown as LocalTime[] | { rows: LocalTime[] };
  const row = Array.isArray(rows) ? rows[0] : rows?.rows?.[0];
  return row ?? null;
}

/** 15-min tick window: fire when the configured HH:MM falls inside the
 *  current quarter-hour. Prevents a hiccup of "exactly HH:00" misses when
 *  the scheduler is a few seconds off. */
function withinTickWindow(nowHour: number, nowMin: number, cfgHour: number, cfgMin: number): boolean {
  const nowTotal = nowHour * 60 + nowMin;
  const cfgTotal = cfgHour * 60 + cfgMin;
  // The cron sidecar fires every 15 min — admit anything within the trailing 14 min.
  const diff = nowTotal - cfgTotal;
  return diff >= 0 && diff < 15;
}

/** Monday of the ISO week BEFORE a given local date — i.e. last week. */
function isoWeekBefore(year: number, week: number): { period: string; from: Date; to: Date } {
  // Week number arithmetic without pulling in a tz lib: use UTC anchors and
  // let the recipient's local display format the timestamps server-side.
  const prevWeek = week - 1;
  const w = prevWeek < 1 ? 52 : prevWeek;
  const y = prevWeek < 1 ? year - 1 : year;
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const mon = new Date(jan4);
  mon.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1) + (w - 1) * 7);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  return { period: `${y}-W${String(w).padStart(2, "0")}`, from: mon, to: sun };
}

function monthBefore(year: number, month: number): { period: string; from: Date; to: Date } {
  const y = month === 1 ? year - 1 : year;
  const m = month === 1 ? 12 : month - 1;
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  return { period: `${y}-${String(m).padStart(2, "0")}`, from, to };
}

/** Previous local calendar day — used for the daily report's window. */
function dayBefore(year: number, month: number, day: number): { period: string; from: Date; to: Date } {
  // Build a UTC anchor for "yesterday 00:00..23:59". The displayed period
  // is YYYY-MM-DD (local), computed by stepping back one day from the
  // provided local date.
  const anchor = new Date(Date.UTC(year, month - 1, day));
  const prev = new Date(anchor.getTime() - 24 * 60 * 60 * 1000);
  const y = prev.getUTCFullYear();
  const m = prev.getUTCMonth() + 1;
  const d = prev.getUTCDate();
  const from = new Date(Date.UTC(y, m - 1, d));
  const to = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));
  return {
    period: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    from,
    to,
  };
}

export async function POST(req: NextRequest) {
  const blocked = await guardCronRequest(req, { bucket: "cron.reports_tick" });
  if (blocked) return blocked;

  const tenantRows = await db
    .select({ id: tenants.id, tz: tenants.timezone })
    .from(tenants)
    .where(sql`${tenants.suspendedAt} IS NULL`);

  let daily = 0;
  let weekly = 0;
  let monthly = 0;
  let deduped = 0;
  let failed = 0;

  for (const t of tenantRows) {
    try {
      const local = await localTime(t.tz);
      if (!local) continue;

      // Config lookup — defaults when no row exists so existing tenants
      // keep working without a backfill.
      const [cfg] = await db
        .select()
        .from(tenantReportSettings)
        .where(eq(tenantReportSettings.tenantId, t.id))
        .limit(1);
      const c = cfg ?? DEFAULT_REPORT_CONFIG;

      const owners = await listOwnerUserIds(t.id);
      if (owners.length === 0) continue;

      // Helper: preview the period revenue + sales for the notification
      // body. Best-effort; a preview failure never blocks the fanout.
      const loadPreview = async (
        from: Date,
        to: Date,
      ): Promise<{ totalRevenueEgp: number | null; salesCount: number | null }> => {
        try {
          const ov = await loadInsightsOverview(t.id, { from, to }, null);
          return {
            totalRevenueEgp: Math.round(ov.metrics.totalRevenue),
            salesCount: ov.metrics.totalSales,
          };
        } catch {
          return { totalRevenueEgp: null, salesCount: null };
        }
      };

      // Helper: check dedupe for every owner and decide whether to fanout.
      const dedupeAll = async (kind: "report", link: string, since: Date): Promise<boolean> => {
        let fired = false;
        for (const userId of owners) {
          const already = await wasAlreadyDispatched({
            tenantId: t.id,
            userId,
            kind,
            link,
            since,
          });
          if (already) deduped += 1;
          else fired = true;
        }
        return fired;
      };

      // ── Daily (configured hour:minute) ─────────────────────────────────
      if (c.dailyEnabled && withinTickWindow(local.hour, local.minute, c.dailyHour, c.dailyMinute)) {
        const day = dayBefore(local.year, local.month, local.day);
        const link = `/reports/daily?period=${encodeURIComponent(day.period)}`;
        const preview = await loadPreview(day.from, day.to);
        if (await dedupeAll("report", link, day.from)) {
          await fanoutEvent(t.id, null, "report.daily", {
            period: day.period,
            totalRevenueEgp: preview.totalRevenueEgp,
            salesCount: preview.salesCount,
            link,
          });
          daily += 1;
        }
      }

      // ── Weekly (configured dow + hour:minute) ──────────────────────────
      if (c.weeklyEnabled && local.jsDow === c.weeklyDow &&
          withinTickWindow(local.hour, local.minute, c.weeklyHour, c.weeklyMinute)) {
        const week = isoWeekBefore(local.year, local.week);
        const link = `/reports/weekly?period=${encodeURIComponent(week.period)}`;
        const preview = await loadPreview(week.from, week.to);
        if (await dedupeAll("report", link, week.from)) {
          await fanoutEvent(t.id, null, "report.weekly", {
            period: week.period,
            totalRevenueEgp: preview.totalRevenueEgp,
            salesCount: preview.salesCount,
            link,
          });
          weekly += 1;
        }
      }

      // ── Monthly (configured day-of-month + hour:minute) ───────────────
      if (c.monthlyEnabled && local.day === c.monthlyDay &&
          withinTickWindow(local.hour, local.minute, c.monthlyHour, c.monthlyMinute)) {
        const month = monthBefore(local.year, local.month);
        const link = `/reports/monthly?period=${encodeURIComponent(month.period)}`;
        const preview = await loadPreview(month.from, month.to);
        if (await dedupeAll("report", link, month.from)) {
          await fanoutEvent(t.id, null, "report.monthly", {
            period: month.period,
            totalRevenueEgp: preview.totalRevenueEgp,
            salesCount: preview.salesCount,
            link,
          });
          monthly += 1;
        }
      }
    } catch (err) {
      failed += 1;
      logger.error({
        event: "cron.reports_tick.tenant_failed",
        tenantId: t.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ tenants: tenantRows.length, daily, weekly, monthly, deduped, failed });
}
