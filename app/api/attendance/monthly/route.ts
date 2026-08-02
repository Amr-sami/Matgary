import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  listAttendanceEvents,
  pairShifts,
} from "@/lib/repo/attendance-events";
import { getAttendanceSettings } from "@/lib/repo/attendance";
import { listTeamMembers } from "@/lib/repo/team";

// GET /api/attendance/monthly?month=YYYY-MM[&employeeId=uuid]
//
// Returns per-employee shift breakdown + rolled-up totals for one calendar
// month. Powers the manager-side monthly attendance view + CSV export in
// team → Attendance.
//
// Response shape (kept small — the client renders directly from it):
// {
//   month: "2026-07",
//   startsAt: ISO, endsAt: ISO,
//   workingDaysInMonth: number,       // calendar minus weekends
//   settings: { workHoursPerDay, weekendDays },
//   employees: [{
//     userId, displayName, username,
//     totals: {
//       shifts: number, hoursTotal: number,
//       regularHours: number, weekendHours: number,
//       daysWorked: number,               // distinct calendar dates with a shift
//       reviewCount: number,              // shifts flagged for review
//       expectedHours: number,            // workingDaysInMonth * workHoursPerDay
//     },
//     shifts: [{
//       date: "YYYY-MM-DD",
//       dayOfWeek: 0-6,
//       isWeekend: boolean,
//       checkInAt: ISO, checkOutAt: ISO | null,
//       hours: number,
//       requiresReview: boolean,
//       checkInSource: string, checkOutSource: string | null,
//       note: string | null,
//     }]
//   }]
// }
export async function GET(req: NextRequest) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const monthStr = url.searchParams.get("month") ?? currentMonthYYYYMM();
  const filterEmployeeId = url.searchParams.get("employeeId");
  const parsed = parseMonth(monthStr);
  if (!parsed) {
    return NextResponse.json(
      { error: "Invalid month — expected YYYY-MM." },
      { status: 400 },
    );
  }
  const { year, monthIndex } = parsed;
  const startsAt = new Date(year, monthIndex, 1, 0, 0, 0, 0);
  const endsAt = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);

  const [settings, members, events] = await Promise.all([
    getAttendanceSettings(r.ctx.tenantId),
    listTeamMembers(r.ctx.tenantId),
    listAttendanceEvents(r.ctx.tenantId, {
      fromDate: startsAt,
      toDate: endsAt,
      employeeId: filterEmployeeId ?? undefined,
    }),
  ]);

  const weekendSet = new Set(settings.weekendDays);
  const workingDaysInMonth = countWorkingDays(startsAt, endsAt, weekendSet);

  const eligibleMembers = members
    .filter((m) => m.role !== "owner")
    .filter((m) => (filterEmployeeId ? m.userId === filterEmployeeId : true));

  const byEmployee = new Map<string, typeof events>();
  for (const e of events) {
    const arr = byEmployee.get(e.employeeId);
    if (arr) arr.push(e);
    else byEmployee.set(e.employeeId, [e]);
  }

  const employees = eligibleMembers.map((m) => {
    const memberEvents = byEmployee.get(m.userId) ?? [];
    // Pair each day's events separately so an open shift crossing midnight
    // doesn't spuriously chain into the next day's check-in.
    const byDate = new Map<string, typeof memberEvents>();
    for (const e of memberEvents) {
      const key = localDateKey(e.occurredAt);
      const arr = byDate.get(key);
      if (arr) arr.push(e);
      else byDate.set(key, [e]);
    }

    const shifts: Array<{
      date: string;
      dayOfWeek: number;
      isWeekend: boolean;
      checkInAt: string;
      checkOutAt: string | null;
      hours: number;
      requiresReview: boolean;
      checkInSource: string;
      checkOutSource: string | null;
      note: string | null;
    }> = [];
    let regularHours = 0;
    let weekendHours = 0;
    let reviewCount = 0;
    const daysWorked = new Set<string>();

    // Sort day keys chronologically so the client can render in order.
    for (const dateKey of Array.from(byDate.keys()).sort()) {
      const dayEvents = byDate.get(dateKey)!;
      const paired = pairShifts(dayEvents);
      const day = new Date(dateKey);
      const dayOfWeek = day.getDay();
      const isWeekend = weekendSet.has(dayOfWeek);
      // Map paired shifts (start/end/hours) back to source metadata by
      // scanning the day's events in order — the pair function stripped it.
      for (const shift of paired) {
        const inEvent = dayEvents.find(
          (e) =>
            e.type === "check_in" &&
            e.occurredAt.getTime() === shift.start.getTime(),
        );
        const outEvent = shift.end
          ? dayEvents.find(
              (e) =>
                e.type === "check_out" &&
                shift.end &&
                e.occurredAt.getTime() === shift.end.getTime(),
            )
          : null;
        shifts.push({
          date: dateKey,
          dayOfWeek,
          isWeekend,
          checkInAt: shift.start.toISOString(),
          checkOutAt: shift.end?.toISOString() ?? null,
          hours: round2(shift.hours),
          requiresReview: shift.requiresReview,
          checkInSource: inEvent?.source ?? "manual",
          checkOutSource: outEvent?.source ?? null,
          note: inEvent?.note ?? outEvent?.note ?? null,
        });
        if (isWeekend) weekendHours += shift.hours;
        else regularHours += shift.hours;
        if (shift.requiresReview) reviewCount += 1;
        daysWorked.add(dateKey);
      }
    }

    return {
      userId: m.userId,
      displayName: m.displayName,
      username: m.username,
      totals: {
        shifts: shifts.length,
        hoursTotal: round2(regularHours + weekendHours),
        regularHours: round2(regularHours),
        weekendHours: round2(weekendHours),
        daysWorked: daysWorked.size,
        reviewCount,
        expectedHours: round2(workingDaysInMonth * settings.workHoursPerDay),
      },
      shifts,
    };
  });

  return NextResponse.json({
    month: monthStr,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    workingDaysInMonth,
    settings: {
      workHoursPerDay: settings.workHoursPerDay,
      weekendDays: settings.weekendDays,
    },
    employees,
  });
}

function currentMonthYYYYMM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function parseMonth(s: string): { year: number; monthIndex: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return { year, monthIndex };
}

function countWorkingDays(
  start: Date,
  end: Date,
  weekend: Set<number>,
): number {
  let n = 0;
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const stop = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cursor.getTime() <= stop.getTime()) {
    if (!weekend.has(cursor.getDay())) n += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return n;
}

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
