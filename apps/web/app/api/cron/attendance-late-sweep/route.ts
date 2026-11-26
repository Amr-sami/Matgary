// Attendance late-arrival sweep.
//
// External scheduler calls this every 5 min. For each tenant + enabled
// employee_schedule row:
//   1. resolve timezone (tenants.timezone, or schedule's override)
//   2. derive local date + day-of-week (JS: 0=Sun..6=Sat)
//   3. skip if today is not a work_days bit
//   4. skip if employee has approved leave covering today
//   5. resolve grace: schedule.grace_minutes OR attendance_settings default
//   6. if local_time > shift_start + grace:
//        a. check for a check_in today — if present AND before threshold → OK
//        b. else fire attendance.late (dedupe: late:<userId>:YYYY-MM-DD)
//
// Idempotency: dedupe via wasAlreadyDispatched (kind='info', link encodes
// userId + date). Multiple ticks in the same day fire once per employee.
//
// No branch filter — Storo has no branches in the notification architecture.

import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import {
  attendanceEvents,
  attendanceSettings,
  employeeSchedules,
  leaveRequests,
  tenantMembers,
  tenants,
  users,
} from "@/lib/db/schema";
import { guardCronRequest } from "@/lib/cron/auth";
import { fanoutEvent } from "@/lib/notifications/dispatch";
import { wasAlreadyDispatched } from "@/lib/notifications/dedupe";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LocalTime {
  localDate: string; // YYYY-MM-DD in tenant tz
  localHhmm: string; // HH:MM in tenant tz
  jsDow: number; // 0=Sun..6=Sat
  localMidnightUtc: Date; // UTC instant equal to local 00:00 today
  localNextMidnightUtc: Date; // UTC instant equal to local 24:00 today
}

async function localNow(tz: string): Promise<LocalTime | null> {
  const rows = (await db.execute(sql`
    select to_char(now() at time zone ${tz}, 'YYYY-MM-DD') as "localDate",
           to_char(now() at time zone ${tz}, 'HH24:MI') as "localHhmm",
           extract(dow from (now() at time zone ${tz}))::int as "jsDow",
           (date_trunc('day', now() at time zone ${tz}) at time zone ${tz}) as "localMidnightUtc",
           ((date_trunc('day', now() at time zone ${tz}) + interval '1 day') at time zone ${tz}) as "localNextMidnightUtc"
  `)) as unknown as LocalTime[] | { rows: LocalTime[] };
  const row = Array.isArray(rows) ? rows[0] : rows?.rows?.[0];
  return row ?? null;
}

/** hh:mm → minutes-since-midnight. Tolerant of hh:mm:ss. */
function hhmmToMinutes(s: string): number {
  const parts = s.split(":").map((p) => Number(p));
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  return h * 60 + m;
}

export interface AttendanceLateSweepResult {
  tenants: number;
  fired: number;
  notLate: number;
  skipped: number;
  deduped: number;
  failed: number;
}

/** Pure sweep logic, callable from tests without hitting the cron rate limiter.
 *  The HTTP handler below is a thin wrapper that enforces guardCronRequest
 *  then delegates to this function. */
export async function runAttendanceLateSweep(): Promise<AttendanceLateSweepResult> {
  const tenantRows = await db
    .select({ id: tenants.id, tz: tenants.timezone })
    .from(tenants)
    .where(sql`${tenants.suspendedAt} IS NULL`);

  let fired = 0;
  let notLate = 0;
  let skipped = 0;
  let deduped = 0;
  let failed = 0;

  for (const t of tenantRows) {
    try {
      // 1. Pull every enabled schedule in the tenant + the tenant default grace.
      const [tenantSettings] = await withTenant(t.id, (tx) =>
        tx
          .select({ graceMinutesLate: attendanceSettings.graceMinutesLate })
          .from(attendanceSettings)
          .where(eq(attendanceSettings.tenantId, t.id))
          .limit(1),
      );
      const defaultGrace = tenantSettings?.graceMinutesLate ?? 0;

      const schedules = await withTenant(t.id, (tx) =>
        tx
          .select({
            userId: employeeSchedules.userId,
            shiftStart: employeeSchedules.shiftStart,
            shiftEnd: employeeSchedules.shiftEnd,
            workDays: employeeSchedules.workDays,
            graceMinutes: employeeSchedules.graceMinutes,
            enabled: employeeSchedules.enabled,
            timezoneOverride: employeeSchedules.timezoneOverride,
          })
          .from(employeeSchedules)
          .where(
            and(eq(employeeSchedules.tenantId, t.id), eq(employeeSchedules.enabled, true)),
          ),
      );
      if (schedules.length === 0) continue;

      for (const s of schedules) {
        try {
          const tz = s.timezoneOverride ?? t.tz;
          const local = await localNow(tz);
          if (!local) {
            skipped += 1;
            continue;
          }

          // 2. Today is a work day for this employee?
          const workMask = s.workDays ?? 0;
          const todayBit = 1 << local.jsDow;
          if ((workMask & todayBit) === 0) {
            skipped += 1;
            continue;
          }

          // 3. Approved leave covering today?
          const hasLeave = await withTenant(t.id, async (tx) => {
            const rows = await tx
              .select({ c: sql<number>`count(*)::int` })
              .from(leaveRequests)
              .where(
                and(
                  eq(leaveRequests.tenantId, t.id),
                  eq(leaveRequests.userId, s.userId),
                  eq(leaveRequests.status, "approved"),
                  lte(leaveRequests.startDate, new Date(local.localNextMidnightUtc)),
                  gte(leaveRequests.endDate, new Date(local.localMidnightUtc)),
                ),
              );
            return Number(rows[0]?.c ?? 0) > 0;
          });
          if (hasLeave) {
            skipped += 1;
            continue;
          }

          // 4. Threshold = shift_start + grace
          const scheduledMin = hhmmToMinutes(String(s.shiftStart));
          const grace = s.graceMinutes === -1 ? defaultGrace : s.graceMinutes;
          const thresholdMin = scheduledMin + grace;
          const nowMin = hhmmToMinutes(local.localHhmm);
          if (nowMin <= thresholdMin) {
            // Grace hasn't expired yet — not late.
            notLate += 1;
            continue;
          }

          // 5. First check-in today?
          const [firstCheckIn] = await withTenant(t.id, (tx) =>
            tx
              .select({ occurredAt: attendanceEvents.occurredAt })
              .from(attendanceEvents)
              .where(
                and(
                  eq(attendanceEvents.tenantId, t.id),
                  eq(attendanceEvents.employeeId, s.userId),
                  eq(attendanceEvents.type, "check_in"),
                  gte(attendanceEvents.occurredAt, new Date(local.localMidnightUtc)),
                  lte(attendanceEvents.occurredAt, new Date(local.localNextMidnightUtc)),
                ),
              )
              .orderBy(sql`${attendanceEvents.occurredAt} asc`)
              .limit(1),
          );

          if (firstCheckIn) {
            // Compare check-in wall-clock to threshold. Postgres rejects a
            // JS Date interpolated into a text query — pass an ISO string
            // and cast it explicitly.
            const checkInIso = new Date(firstCheckIn.occurredAt).toISOString();
            const result = (await db.execute(sql`
              select to_char(${checkInIso}::timestamptz at time zone ${tz}, 'HH24:MI') as hhmm
            `)) as unknown as { hhmm: string }[] | { rows: { hhmm: string }[] };
            const rows = Array.isArray(result) ? result : result?.rows ?? [];
            const checkInMin = hhmmToMinutes(rows[0]?.hhmm ?? "00:00");
            if (checkInMin <= thresholdMin) {
              notLate += 1;
              continue;
            }
            // Present but late — fall through to fanout.
          }
          // else: no check-in yet + grace expired → late.

          // 6. Resolve recipient (owner always; permission gate handles staff).
          const owners = await withTenant(t.id, (tx) =>
            tx
              .select({ userId: tenantMembers.userId })
              .from(tenantMembers)
              .where(
                and(
                  eq(tenantMembers.tenantId, t.id),
                  eq(tenantMembers.role, "owner"),
                ),
              ),
          );

          // 7. Dedupe once per (userId, date).
          const link = `/team/attendance?user=${s.userId}&date=${local.localDate}&late=1`;
          let shouldFire = false;
          for (const o of owners) {
            const already = await wasAlreadyDispatched({
              tenantId: t.id,
              userId: o.userId,
              kind: "info",
              link,
              since: new Date(local.localMidnightUtc),
            });
            if (already) deduped += 1;
            else shouldFire = true;
          }
          if (!shouldFire) continue;

          // 8. Fetch employee display name for the payload.
          const [empRow] = await withTenant(t.id, (tx) =>
            tx
              .select({
                displayName: tenantMembers.displayName,
                userName: users.name,
              })
              .from(tenantMembers)
              .innerJoin(users, eq(users.id, tenantMembers.userId))
              .where(
                and(
                  eq(tenantMembers.tenantId, t.id),
                  eq(tenantMembers.userId, s.userId),
                ),
              )
              .limit(1),
          );

          const actualCheckInIso = firstCheckIn
            ? new Date(firstCheckIn.occurredAt).toISOString()
            : null;
          const lateMinutes = nowMin - thresholdMin;

          await fanoutEvent(t.id, null, "attendance.late", {
            employeeUserId: s.userId,
            employeeName:
              empRow?.displayName ?? empRow?.userName ?? "",
            date: local.localDate,
            scheduledStart: String(s.shiftStart).slice(0, 5),
            graceMinutes: grace,
            lateMinutes,
            actualCheckIn: actualCheckInIso,
            link,
          });
          fired += 1;
        } catch (err) {
          failed += 1;
          logger.error({
            event: "cron.attendance_late_sweep.schedule_failed",
            tenantId: t.id,
            userId: s.userId,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      failed += 1;
      logger.error({
        event: "cron.attendance_late_sweep.tenant_failed",
        tenantId: t.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    tenants: tenantRows.length,
    fired,
    notLate,
    skipped,
    deduped,
    failed,
  };
}

export async function POST(req: NextRequest) {
  const blocked = await guardCronRequest(req, { bucket: "cron.attendance_late_sweep" });
  if (blocked) return blocked;
  const result = await runAttendanceLateSweep();
  return NextResponse.json(result);
}
