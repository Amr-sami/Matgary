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
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { tenants } from "@/lib/db/schema";
import { guardCronRequest } from "@/lib/cron/auth";
import { fanoutEvent } from "@/lib/notifications/dispatch";
import { loadInsightsOverview } from "@/lib/repo/insights";
import { listOwnerUserIds, wasAlreadyDispatched } from "@/lib/notifications/dedupe";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LocalTime {
  hour: number;
  dow: number; // 1=Mon..7=Sun (Postgres ISO)
  day: number;
  year: number;
  month: number;
  week: number;
}

/** ISO week number of a Date in the tenant's local timezone. */
async function localTime(tz: string): Promise<LocalTime | null> {
  const rows = (await db.execute(sql`
    select extract(hour from (now() at time zone ${tz}))::int as hour,
           extract(isodow from (now() at time zone ${tz}))::int as dow,
           extract(day from (now() at time zone ${tz}))::int as day,
           extract(isoyear from (now() at time zone ${tz}))::int as year,
           extract(month from (now() at time zone ${tz}))::int as month,
           extract(week from (now() at time zone ${tz}))::int as week
  `)) as unknown as LocalTime[] | { rows: LocalTime[] };
  const row = Array.isArray(rows) ? rows[0] : rows?.rows?.[0];
  return row ?? null;
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

export async function POST(req: NextRequest) {
  const blocked = await guardCronRequest(req, { bucket: "cron.reports_tick" });
  if (blocked) return blocked;

  const tenantRows = await db
    .select({ id: tenants.id, tz: tenants.timezone })
    .from(tenants)
    .where(sql`${tenants.suspendedAt} IS NULL`);

  let weekly = 0;
  let monthly = 0;
  let deduped = 0;
  let failed = 0;

  for (const t of tenantRows) {
    try {
      const local = await localTime(t.tz);
      if (!local) continue;
      const hour = local.hour;
      if (hour !== 8) continue;

      const owners = await listOwnerUserIds(t.id);
      if (owners.length === 0) continue;

      // ── Weekly (Mon 08:00 local) ──────────────────────────────────────
      if (local.dow === 1) {
        const week = isoWeekBefore(local.year, local.week);
        const link = `/reports/weekly?period=${encodeURIComponent(week.period)}`;
        const dedupeSince = week.from;

        // Compute headline preview once per tenant.
        let totalRevenueEgp: number | null = null;
        let salesCount: number | null = null;
        try {
          const ov = await loadInsightsOverview(t.id, { from: week.from, to: week.to }, null);
          totalRevenueEgp = Math.round(ov.metrics.totalRevenue);
          salesCount = ov.metrics.totalSales;
        } catch {
          /* preview is best-effort */
        }

        let fired = false;
        for (const userId of owners) {
          const already = await wasAlreadyDispatched({
            tenantId: t.id,
            userId,
            kind: "report",
            link,
            since: dedupeSince,
          });
          if (already) {
            deduped += 1;
            continue;
          }
          fired = true;
        }
        if (fired) {
          await fanoutEvent(t.id, null, "report.weekly", {
            period: week.period,
            totalRevenueEgp,
            salesCount,
            link,
          });
          weekly += 1;
        }
      }

      // ── Monthly (day 1, 08:00 local) ──────────────────────────────────
      if (local.day === 1) {
        const month = monthBefore(local.year, local.month);
        const link = `/reports/monthly?period=${encodeURIComponent(month.period)}`;
        const dedupeSince = month.from;

        let totalRevenueEgp: number | null = null;
        let salesCount: number | null = null;
        try {
          const ov = await loadInsightsOverview(t.id, { from: month.from, to: month.to }, null);
          totalRevenueEgp = Math.round(ov.metrics.totalRevenue);
          salesCount = ov.metrics.totalSales;
        } catch {
          /* preview is best-effort */
        }

        let fired = false;
        for (const userId of owners) {
          const already = await wasAlreadyDispatched({
            tenantId: t.id,
            userId,
            kind: "report",
            link,
            since: dedupeSince,
          });
          if (already) {
            deduped += 1;
            continue;
          }
          fired = true;
        }
        if (fired) {
          await fanoutEvent(t.id, null, "report.monthly", {
            period: month.period,
            totalRevenueEgp,
            salesCount,
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

  return NextResponse.json({ tenants: tenantRows.length, weekly, monthly, deduped, failed });
}
