import type { Shift } from "@/lib/repo/attendance-events";
import type { AttendanceSettingsDto } from "@/lib/repo/attendance";

// Pure compute layer for payroll. Extracted from computePeriodGross so the
// per-day regular/overtime split, the hybrid vs hourly vs fixed pay branches,
// and the mid-period rate change behaviour can all be unit-tested without
// touching Postgres.
//
// CompensationDto + pickEffectiveCompensation live here (not in payroll.ts)
// to break the import cycle: payroll.ts pulls the compute pieces from this
// module and re-exports the DTO so existing callers stay unbroken.

export type PayType = "fixed" | "hourly" | "hybrid";

export interface CompensationDto {
  id: string;
  employeeId: string;
  payType: PayType;
  baseSalaryMonthly: number | null;
  hourlyRate: number | null;
  standardMonthlyHours: number | null;
  effectiveFrom: Date;
  createdByUserId: string;
  createdAt: Date;
}

/** Pick the compensation row that was effective on the given date. */
export function pickEffectiveCompensation(
  history: CompensationDto[],
  on: Date,
): CompensationDto | null {
  // history is already newest-first
  for (const c of history) {
    if (c.effectiveFrom.getTime() <= on.getTime()) return c;
  }
  return null;
}

export interface ComputedGross {
  /** Hours that fell inside `workHoursPerDay` on a non-weekend day. */
  regularHours: number;
  /** Hours over `workHoursPerDay` per day, plus all hours on weekend days. */
  overtimeHours: number;
  /** Number of shifts flagged for manager review. */
  reviewCount: number;
  /** Pro-rated monthly base earnings rolled across the period. */
  baseEarnings: number;
  /** Sum of regular + overtime hourly earnings (overtime carries the multiplier). */
  hourlyEarnings: number;
  /** baseEarnings + hourlyEarnings, rounded to 2 decimal places. */
  grossAmount: number;
}

export function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isoDayOfWeek(date: Date): number {
  // JS getDay() is 0(Sun)..6(Sat); ISO is 1(Mon)..7(Sun).
  return ((date.getDay() + 6) % 7) + 1;
}

export function computeGrossFromShifts(
  shifts: Shift[],
  history: CompensationDto[],
  settings: AttendanceSettingsDto,
): ComputedGross {
  // Roll shifts into daily-hour totals; open shifts (no end) contribute 0.
  const dailyHours = new Map<string, number>();
  for (const s of shifts) {
    if (s.end == null) continue;
    const dayKey = s.start.toISOString().slice(0, 10);
    dailyHours.set(dayKey, (dailyHours.get(dayKey) ?? 0) + s.hours);
  }

  let regularHours = 0;
  let overtimeHours = 0;
  let hourlyEarnings = 0;
  const baseDaysByMonth = new Map<string, number>();

  for (const [dayKey, hours] of dailyHours) {
    const day = new Date(dayKey);
    const isWeekend = settings.weekendDays.includes(isoDayOfWeek(day));
    const cap = settings.workHoursPerDay;
    const dayRegular = isWeekend ? 0 : Math.min(hours, cap);
    const dayOvertime = isWeekend ? hours : Math.max(0, hours - cap);
    regularHours += dayRegular;
    overtimeHours += dayOvertime;

    const comp = pickEffectiveCompensation(history, day);
    if (!comp) continue;

    if (comp.payType === "hourly") {
      const rate = comp.hourlyRate ?? 0;
      hourlyEarnings +=
        dayRegular * rate + dayOvertime * rate * settings.overtimeMultiplier;
    } else if (comp.payType === "hybrid") {
      const rate = comp.hourlyRate ?? 0;
      // Base salary covers the regular weekday hours; OT + weekends bill hourly.
      hourlyEarnings += dayOvertime * rate * settings.overtimeMultiplier;
      const monthKey = dayKey.slice(0, 7);
      baseDaysByMonth.set(monthKey, (baseDaysByMonth.get(monthKey) ?? 0) + 1);
    } else {
      // fixed
      const monthKey = dayKey.slice(0, 7);
      baseDaysByMonth.set(monthKey, (baseDaysByMonth.get(monthKey) ?? 0) + 1);
    }
  }

  // Pro-rate the monthly base by days worked / days in calendar month. Uses
  // the 15th-of-month as a stable probe for "which comp row applies" so a
  // mid-period rate change still picks one consistent base for that month.
  let baseEarnings = 0;
  for (const [monthKey, daysWorked] of baseDaysByMonth) {
    const [yyyy, mm] = monthKey.split("-").map(Number);
    const daysInMonth = new Date(yyyy, mm, 0).getDate();
    const probe = new Date(yyyy, mm - 1, 15);
    const comp = pickEffectiveCompensation(history, probe);
    if (!comp) continue;
    if (comp.payType !== "fixed" && comp.payType !== "hybrid") continue;
    const monthly = comp.baseSalaryMonthly ?? 0;
    baseEarnings += (monthly * daysWorked) / daysInMonth;
  }

  const reviewCount = shifts.filter((s) => s.requiresReview).length;
  const grossAmount = roundTo2(baseEarnings + hourlyEarnings);

  return {
    regularHours: roundTo2(regularHours),
    overtimeHours: roundTo2(overtimeHours),
    reviewCount,
    baseEarnings: roundTo2(baseEarnings),
    hourlyEarnings: roundTo2(hourlyEarnings),
    grossAmount,
  };
}
