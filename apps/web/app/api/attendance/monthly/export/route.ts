import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  listAttendanceEvents,
  pairShifts,
} from "@/lib/repo/attendance-events";
import { getAttendanceSettings } from "@/lib/repo/attendance";
import { listTeamMembers } from "@/lib/repo/team";

// GET /api/attendance/monthly/export?month=YYYY-MM[&employeeId=uuid][&locale=ar|en]
//
// Streams a UTF-8 CSV (with BOM) of one month's attendance in a pivot layout
// that mirrors the paper timesheet managers already know:
//
//   • Row 1 — employee names, each spanning two columns.
//   • Row 2 — sub-header: "Date" then "حضور" / "انصراف" per employee.
//   • Body  — one row per calendar day of the month. Blank cells for absences.
//     If an employee logged multiple shifts in one day, we surface the
//     earliest check-in and the latest check-out (matches how paper sheets
//     record the day) — the daily hours cell still sums every shift.
//   • Total — bottom row: hours worked in the month per employee.
//
// Excel opens it correctly in Arabic thanks to the leading BOM.
export async function GET(req: NextRequest) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const monthStr = url.searchParams.get("month") ?? currentMonthYYYYMM();
  const filterEmployeeId = url.searchParams.get("employeeId");
  const locale = url.searchParams.get("locale") === "en" ? "en" : "ar";
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
  const L = LABELS[locale];

  const eligibleMembers = members
    .filter((m) => m.role !== "owner")
    .filter((m) => (filterEmployeeId ? m.userId === filterEmployeeId : true))
    // Stable order — displayName ascending — so re-exports don't jitter.
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  // Group each employee's events by local date.
  const perEmployee = new Map<string, Map<string, typeof events>>();
  for (const m of eligibleMembers) perEmployee.set(m.userId, new Map());
  for (const e of events) {
    const map = perEmployee.get(e.employeeId);
    if (!map) continue;
    const key = localDateKey(e.occurredAt);
    const arr = map.get(key);
    if (arr) arr.push(e);
    else map.set(key, [e]);
  }

  // Pre-compute a day summary + rolling total per employee.
  interface DaySummary {
    firstIn: Date | null;
    lastOut: Date | null;
    hours: number;
  }
  const daySummaryFor = (dayEvents: typeof events): DaySummary => {
    const shifts = pairShifts(dayEvents);
    if (shifts.length === 0) return { firstIn: null, lastOut: null, hours: 0 };
    let hours = 0;
    let firstIn: Date | null = null;
    let lastOut: Date | null = null;
    for (const s of shifts) {
      hours += s.hours;
      if (!firstIn || s.start < firstIn) firstIn = s.start;
      if (s.end && (!lastOut || s.end > lastOut)) lastOut = s.end;
    }
    return { firstIn, lastOut, hours };
  };

  const totals = new Map<string, number>();
  for (const m of eligibleMembers) totals.set(m.userId, 0);

  // ── Row 1: employee name header ─────────────────────────────────────────
  const nameRow: string[] = [""];
  for (const m of eligibleMembers) {
    nameRow.push(m.displayName);
    // Blank so Excel sees the name spanning two columns visually.
    nameRow.push("");
  }

  // ── Row 2: sub-header (Date + حضور / انصراف per employee) ───────────────
  const subHeader: string[] = [L.date];
  for (const _ of eligibleMembers) {
    subHeader.push(L.checkIn);
    subHeader.push(L.checkOut);
  }

  // ── Body: one row per calendar day of the month ─────────────────────────
  const bodyRows: string[][] = [];
  const cursor = new Date(year, monthIndex, 1);
  while (cursor.getMonth() === monthIndex) {
    const dateKey = localDateKey(cursor);
    const dow = cursor.getDay();
    const isWeekend = weekendSet.has(dow);
    // First column: "01 · الخميس" — day-of-month + short day name so a
    // manager can scan without cross-referencing a calendar.
    const dayLabel = `${String(cursor.getDate()).padStart(2, "0")} · ${DAY_NAMES[locale][dow]}${
      isWeekend ? ` (${L.weekendMark})` : ""
    }`;
    const row: string[] = [dayLabel];
    for (const m of eligibleMembers) {
      const dayEvents = perEmployee.get(m.userId)?.get(dateKey) ?? [];
      const summary = daySummaryFor(dayEvents);
      row.push(summary.firstIn ? formatTimeHm(summary.firstIn) : "");
      row.push(summary.lastOut ? formatTimeHm(summary.lastOut) : "");
      totals.set(m.userId, (totals.get(m.userId) ?? 0) + summary.hours);
    }
    bodyRows.push(row);
    cursor.setDate(cursor.getDate() + 1);
  }

  // ── Total row: hours per employee. Total goes in the حضور cell of each
  //    pair so it lines up under the check-in column visually. ─────────────
  const totalRow: string[] = [L.totalHours];
  for (const m of eligibleMembers) {
    const hours = totals.get(m.userId) ?? 0;
    totalRow.push(`${round2(hours)} ${L.hourUnit}`);
    totalRow.push("");
  }

  const allRows = [nameRow, subHeader, ...bodyRows, totalRow];
  const csvBody = allRows
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");

  // BOM so Excel decodes as UTF-8 (Arabic renders correctly).
  const body = "﻿" + csvBody + "\r\n";
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="attendance_${monthStr}.csv"`,
    },
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

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTimeHm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Excel-safe CSV escaping — quote anything with commas, quotes, newlines,
// or a leading formula character.
function csvCell(s: string): string {
  const needsQuote = /[",\n\r]/.test(s) || /^[=+\-@]/.test(s);
  if (needsQuote) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const LABELS = {
  ar: {
    date: "التاريخ",
    checkIn: "حضور",
    checkOut: "انصراف",
    totalHours: "إجمالي الساعات",
    hourUnit: "س",
    weekendMark: "عطلة",
  },
  en: {
    date: "Date",
    checkIn: "In",
    checkOut: "Out",
    totalHours: "Total hours",
    hourUnit: "h",
    weekendMark: "Weekend",
  },
} as const;

const DAY_NAMES: Record<"ar" | "en", readonly string[]> = {
  ar: ["أحد", "اثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
} as const;
