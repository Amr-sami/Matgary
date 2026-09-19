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
import {
  computeGrossFromShifts,
  pickEffectiveCompensation,
  type CompensationDto,
  type PayType,
} from "@/lib/repo/payroll-compute";

// Re-export the DTO + the pure picker so existing call sites keep importing
// from @/lib/repo/payroll. The canonical source is now payroll-compute.
export {
  pickEffectiveCompensation,
  type CompensationDto,
  type PayType,
};

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
  const gross = computeGrossFromShifts(shifts, history, settings);

  const notes: string[] = [];
  if (gross.baseEarnings > 0) {
    notes.push(`راتب أساسي محسوب نسبياً: ${gross.baseEarnings} ج.م`);
  }
  if (gross.hourlyEarnings > 0) {
    notes.push(`أجر بالساعة: ${gross.hourlyEarnings} ج.م`);
  }
  if (gross.reviewCount > 0) {
    notes.push(`تنبيه: ${gross.reviewCount} فترة تحتاج مراجعة`);
  }

  return {
    periodStart,
    periodEnd,
    shifts,
    regularHours: gross.regularHours,
    overtimeHours: gross.overtimeHours,
    reviewCount: gross.reviewCount,
    grossAmount: gross.grossAmount,
    notes,
  };
}
