import { and, desc, eq } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  employeeCompensation,
  type EmployeeCompensationRow,
} from "@/lib/db/schema";
import {
  listAttendanceEvents,
  pairShifts,
  type Shift,
} from "@/lib/repo/attendance-events";
import {
  getAttendanceSettings,
  type AttendanceSettingsDto,
} from "@/lib/repo/attendance";

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

function rowToDto(row: EmployeeCompensationRow): CompensationDto {
  return {
    id: row.id,
    employeeId: row.employeeId,
    payType: row.payType as PayType,
    baseSalaryMonthly:
      row.baseSalaryMonthly == null ? null : Number(row.baseSalaryMonthly),
    hourlyRate: row.hourlyRate == null ? null : Number(row.hourlyRate),
    standardMonthlyHours:
      row.standardMonthlyHours == null
        ? null
        : Number(row.standardMonthlyHours),
    effectiveFrom: row.effectiveFrom,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  };
}

/** Return every compensation row for an employee, newest first. */
export async function listCompensationHistory(
  tenantId: string,
  employeeId: string,
): Promise<CompensationDto[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(employeeCompensation)
      .where(
        and(
          eq(employeeCompensation.tenantId, tenantId),
          eq(employeeCompensation.employeeId, employeeId),
        ),
      )
      .orderBy(desc(employeeCompensation.effectiveFrom));
    return rows.map(rowToDto);
  });
}

export interface CreateCompensationInput {
  employeeId: string;
  payType: PayType;
  baseSalaryMonthly: number | null;
  hourlyRate: number | null;
  standardMonthlyHours: number | null;
  effectiveFrom: Date;
  createdByUserId: string;
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

export async function createCompensation(
  tenantId: string,
  input: CreateCompensationInput,
): Promise<CompensationDto> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .insert(employeeCompensation)
      .values({
        tenantId,
        employeeId: input.employeeId,
        payType: input.payType,
        baseSalaryMonthly:
          input.baseSalaryMonthly == null
            ? null
            : String(input.baseSalaryMonthly),
        hourlyRate:
          input.hourlyRate == null ? null : String(input.hourlyRate),
        standardMonthlyHours:
          input.standardMonthlyHours == null
            ? null
            : String(input.standardMonthlyHours),
        effectiveFrom: input.effectiveFrom,
        createdByUserId: input.createdByUserId,
      })
      .returning();
    return rowToDto(row);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Period gross computation
// ─────────────────────────────────────────────────────────────────────────────

export interface PeriodGross {
  periodStart: Date;
  periodEnd: Date;
  shifts: Shift[];
  /** Hours within the configured work_hours_per_day window. */
  regularHours: number;
  /** Hours over work_hours_per_day per day, plus all hours on weekend days. */
  overtimeHours: number;
  /** Number of shifts that need manager review (open / unmatched). */
  reviewCount: number;
  /** Composite gross — base + (overtime hrs × hourly_rate × multiplier) for hybrid; etc. */
  grossAmount: number;
  /** Plain-text breakdown for the UI. */
  notes: string[];
}

/**
 * Compute the gross pay for one employee over a half-open [start, end) range.
 * Pairs events into shifts, then for each shift looks up the compensation row
 * effective on that day. Splits into regular + overtime hours by the tenant's
 * work_hours_per_day rule and weekend days.
 *
 * Mid-period compensation changes are honored — every shift uses the row that
 * was effective on its start date.
 */
export async function computePeriodGross(
  tenantId: string,
  employeeId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<PeriodGross> {
  const [events, history, settings] = await Promise.all([
    listAttendanceEvents(tenantId, {
      employeeId,
      fromDate: periodStart,
      toDate: periodEnd,
    }),
    listCompensationHistory(tenantId, employeeId),
    getAttendanceSettings(tenantId),
  ]);
  const shifts = pairShifts(events);

  const dailyHours = new Map<string, number>();
  for (const s of shifts) {
    if (s.end == null) continue; // open shift — counted as 0 until closed
    const dayKey = s.start.toISOString().slice(0, 10);
    dailyHours.set(dayKey, (dailyHours.get(dayKey) ?? 0) + s.hours);
  }

  let regularHours = 0;
  let overtimeHours = 0;
  let totalHourlyEarnings = 0;
  let totalBaseDays = 0; // number of days a "fixed/hybrid" base salary should accrue
  const baseDaysByMonth = new Map<string, number>();

  for (const [dayKey, hours] of dailyHours) {
    const day = new Date(dayKey);
    const isoDow = ((day.getDay() + 6) % 7) + 1; // JS 0(Sun)..6(Sat) → ISO 1(Mon)..7(Sun)
    const isWeekend = settings.weekendDays.includes(isoDow);
    const cap = settings.workHoursPerDay;
    const dayRegular = isWeekend ? 0 : Math.min(hours, cap);
    const dayOvertime = isWeekend ? hours : Math.max(0, hours - cap);
    regularHours += dayRegular;
    overtimeHours += dayOvertime;

    const comp = pickEffectiveCompensation(history, day);
    if (!comp) continue;

    if (comp.payType === "hourly") {
      const rate = comp.hourlyRate ?? 0;
      totalHourlyEarnings +=
        dayRegular * rate + dayOvertime * rate * settings.overtimeMultiplier;
    } else if (comp.payType === "hybrid") {
      const rate = comp.hourlyRate ?? 0;
      // base salary covers hours up to cap on weekdays; OT and weekend hours billed hourly
      totalHourlyEarnings +=
        dayOvertime * rate * settings.overtimeMultiplier;
      totalBaseDays += 1;
      const monthKey = dayKey.slice(0, 7);
      baseDaysByMonth.set(monthKey, (baseDaysByMonth.get(monthKey) ?? 0) + 1);
    } else {
      // fixed: base only
      totalBaseDays += 1;
      const monthKey = dayKey.slice(0, 7);
      baseDaysByMonth.set(monthKey, (baseDaysByMonth.get(monthKey) ?? 0) + 1);
    }
  }

  // Pro-rate base salary by days actually worked vs. days in the month.
  let baseEarnings = 0;
  for (const [monthKey, daysWorked] of baseDaysByMonth) {
    const [yyyy, mm] = monthKey.split("-").map(Number);
    const daysInMonth = new Date(yyyy, mm, 0).getDate();
    // Use the comp row effective on the 15th of that month as a stable proxy.
    const probe = new Date(yyyy, mm - 1, 15);
    const comp = pickEffectiveCompensation(history, probe);
    if (!comp || (comp.payType !== "fixed" && comp.payType !== "hybrid")) {
      continue;
    }
    const monthly = comp.baseSalaryMonthly ?? 0;
    baseEarnings += (monthly * daysWorked) / daysInMonth;
  }

  const grossAmount = baseEarnings + totalHourlyEarnings;
  const reviewCount = shifts.filter((s) => s.requiresReview).length;

  const notes: string[] = [];
  if (baseEarnings > 0) {
    notes.push(`راتب أساسي محسوب نسبياً: ${roundTo2(baseEarnings)} ج.م`);
  }
  if (totalHourlyEarnings > 0) {
    notes.push(`أجر بالساعة: ${roundTo2(totalHourlyEarnings)} ج.م`);
  }
  if (reviewCount > 0) {
    notes.push(`تنبيه: ${reviewCount} فترة تحتاج مراجعة`);
  }

  return {
    periodStart,
    periodEnd,
    shifts,
    regularHours: roundTo2(regularHours),
    overtimeHours: roundTo2(overtimeHours),
    reviewCount,
    grossAmount: roundTo2(grossAmount),
    notes,
  };
}

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}
