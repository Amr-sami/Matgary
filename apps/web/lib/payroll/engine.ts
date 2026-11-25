// Payroll V1 — deterministic snapshot engine.
//
// The engine takes everything that affects a single employee's monthly sheet
// (attendance, compensation history in effect, approved leave, sales +
// returns attributed to the employee, Owner-authored adjustments) and
// returns one `PayrollSnapshot`: the full breakdown that the UI, the P&L,
// the PDF and the AI preview all read from. Re-running against the same
// inputs produces an identical snapshot — the "deterministic" in the name.
//
// Finalization freezes the snapshot JSONB onto `payroll_periods`; later rate
// changes, newly approved leave, or voided sales cannot re-compute an
// already-finalized period. The DB-level immutability trigger in
// 0068_payroll_v1.sql enforces this at the storage layer.
//
// Split into a pure `composePayrollSnapshot(inputs)` core + an async
// `computePayrollForEmployee(...)` wrapper that loads the inputs from
// Postgres. Tests exercise the pure core without touching the DB.

import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import {
  attendanceEvents,
  employeeCompensation,
  leaveRequests,
  payrollAdjustments,
  returns,
  sales,
  tenantMembers,
  users,
  type AttendanceEventRow,
  type EmployeeCompensationRow,
  type PayrollAdjustmentRow,
} from "@/lib/db/schema";
import { getAttendanceSettings, type AttendanceSettingsDto } from "@/lib/repo/attendance";
import { pairShifts, type AttendanceEventDto } from "@/lib/repo/attendance-events";
import {
  computeGrossFromShifts,
  pickEffectiveCompensation,
  roundTo2,
  type CommissionBase,
  type CompensationDto,
  type PayType,
} from "@/lib/repo/payroll-compute";

export const PAYROLL_CALCULATION_VERSION = 1 as const;

/* ─────────────────────────── Snapshot types ──────────────────────────── */

export type { CommissionBase };

export interface CompensationSnapshot {
  id: string;
  payType: PayType;
  baseSalaryMonthly: number | null;
  hourlyRate: number | null;
  standardMonthlyHours: number | null;
  commissionRate: number;
  commissionBase: CommissionBase;
  bonusEligible: boolean;
  effectiveFrom: string; // ISO
}

export interface AdjustmentSnapshot {
  id: string;
  kind: "bonus" | "deduction" | "advance_repayment" | "correction";
  amount: number;
  reason: string | null;
  createdByUserId: string;
  createdAt: string; // ISO
}

export interface PayrollWarning {
  /** Short machine code — the UI maps to a localized sentence. */
  code:
    | "no_compensation"
    | "open_shifts"
    | "missing_attendance"
    | "unapproved_overtime"
    | "no_sales_attribution";
  message: string;
}

export interface PayrollSnapshot {
  calculationVersion: typeof PAYROLL_CALCULATION_VERSION;
  periodStart: string; // ISO (first of month, UTC midnight)
  periodEnd: string;   // ISO (first of NEXT month, UTC midnight — half-open)
  employeeId: string;

  // Attendance
  regularHours: number;
  overtimeHours: number;
  reviewCount: number;

  // Leave (days overlapping the period)
  paidLeaveDays: number;
  unpaidLeaveDays: number;

  // Pay composition
  payType: PayType;
  baseEarnings: number;
  hourlyEarnings: number;
  grossAmount: number;

  // Commission
  commissionBase: CommissionBase;
  commissionRate: number;
  commissionGrossSales: number;
  commissionReturnedValue: number;
  commissionNetSales: number;
  commissionAmount: number;

  // Adjustments (sign-carrying)
  adjustments: AdjustmentSnapshot[];
  adjustmentsTotal: number;

  // Net = grossAmount + commissionAmount + adjustmentsTotal
  netAmount: number;

  // Warnings the UI/Owner should see. Does NOT block finalize.
  warnings: PayrollWarning[];
}

/* ─────────────────────────── Pure composer ───────────────────────────── */

export interface ComposePayrollInputs {
  periodStart: Date;
  periodEnd: Date;
  employeeId: string;
  compensationHistory: CompensationDto[];
  attendanceEvents: AttendanceEventDto[];
  attendanceSettings: AttendanceSettingsDto;
  /** Approved leave requests whose [start, end] overlaps the period. */
  approvedLeave: Array<{ startDate: Date; endDate: Date; kind: "paid" | "unpaid" }>;
  /** Live (non-voided) adjustments for the period, sorted by createdAt asc. */
  adjustments: AdjustmentSnapshot[];
  /** Sum of sales.totalPrice recorded_by this employee in the period (returns NOT subtracted). */
  grossSales: number;
  /** Sum of refund value from `returns` whose ORIGINAL sale was recorded_by this employee,
   *  and whose return_date is in the period. */
  returnedValue: number;
}

export function composePayrollSnapshot(inp: ComposePayrollInputs): {
  snapshot: PayrollSnapshot;
  compensationSnapshot: CompensationSnapshot | null;
} {
  const warnings: PayrollWarning[] = [];

  // Pick the compensation row in effect at the START of the period. Mid-period
  // changes still get honored by `computeGrossFromShifts`, which picks per
  // shift day; the snapshot's `compensationSnapshot` captures the primary
  // row that governed the period for audit/PDF purposes.
  const primaryComp = pickEffectiveCompensation(inp.compensationHistory, inp.periodStart);

  // Attendance → hours + base/hourly earnings
  const shifts = pairShifts(inp.attendanceEvents);
  const gross = computeGrossFromShifts(
    shifts,
    inp.compensationHistory,
    inp.attendanceSettings,
  );

  if (!primaryComp) {
    warnings.push({
      code: "no_compensation",
      message: "No compensation row effective at period start — base pay is 0",
    });
  }
  if (gross.reviewCount > 0) {
    warnings.push({
      code: "open_shifts",
      message: `${gross.reviewCount} shift(s) need review (forgot to check in/out)`,
    });
  }
  if (shifts.length === 0) {
    warnings.push({
      code: "missing_attendance",
      message: "No attendance events in this period",
    });
  }

  // Leave (count distinct calendar days overlapped with the period, by kind).
  const paidDays = new Set<string>();
  const unpaidDays = new Set<string>();
  for (const lv of inp.approvedLeave) {
    const windowStart = Math.max(lv.startDate.getTime(), inp.periodStart.getTime());
    const windowEnd = Math.min(lv.endDate.getTime(), inp.periodEnd.getTime() - 1);
    if (windowEnd < windowStart) continue;
    for (let t = windowStart; t <= windowEnd; t += 86400000) {
      const day = new Date(t).toISOString().slice(0, 10);
      (lv.kind === "paid" ? paidDays : unpaidDays).add(day);
    }
  }

  // Commission — V1 computes `commissionNetSales * commissionRate / 100`.
  // `profit_contribution` is reserved for V2 and falls back to the same base.
  const commissionRate = primaryComp?.commissionRate ?? 0;
  const commissionBase: CommissionBase = primaryComp?.commissionBase ?? "gross_sales";
  const commissionNetSales = roundTo2(Math.max(0, inp.grossSales - inp.returnedValue));
  const commissionAmount = roundTo2((commissionNetSales * commissionRate) / 100);
  if (commissionRate > 0 && inp.grossSales === 0) {
    warnings.push({
      code: "no_sales_attribution",
      message: "Commission rate set but no sales recorded in this employee's name",
    });
  }

  // Adjustments — sign already carried by `amount`.
  const adjustmentsTotal = roundTo2(
    inp.adjustments.reduce((acc, a) => acc + a.amount, 0),
  );

  // Net
  const grossAmount = gross.grossAmount;
  const netAmount = roundTo2(grossAmount + commissionAmount + adjustmentsTotal);

  const snapshot: PayrollSnapshot = {
    calculationVersion: PAYROLL_CALCULATION_VERSION,
    periodStart: inp.periodStart.toISOString(),
    periodEnd: inp.periodEnd.toISOString(),
    employeeId: inp.employeeId,

    regularHours: gross.regularHours,
    overtimeHours: gross.overtimeHours,
    reviewCount: gross.reviewCount,

    paidLeaveDays: paidDays.size,
    unpaidLeaveDays: unpaidDays.size,

    payType: (primaryComp?.payType ?? "fixed") as PayType,
    baseEarnings: gross.baseEarnings,
    hourlyEarnings: gross.hourlyEarnings,
    grossAmount,

    commissionBase,
    commissionRate,
    commissionGrossSales: roundTo2(inp.grossSales),
    commissionReturnedValue: roundTo2(inp.returnedValue),
    commissionNetSales,
    commissionAmount,

    adjustments: inp.adjustments,
    adjustmentsTotal,

    netAmount,
    warnings,
  };

  const compensationSnapshot: CompensationSnapshot | null = primaryComp
    ? {
        id: primaryComp.id,
        payType: primaryComp.payType,
        baseSalaryMonthly: primaryComp.baseSalaryMonthly,
        hourlyRate: primaryComp.hourlyRate,
        standardMonthlyHours: primaryComp.standardMonthlyHours,
        commissionRate: primaryComp.commissionRate,
        commissionBase: primaryComp.commissionBase,
        bonusEligible: primaryComp.bonusEligible,
        effectiveFrom: primaryComp.effectiveFrom.toISOString(),
      }
    : null;

  return { snapshot, compensationSnapshot };
}

/* ─────────────────────── DB loader + convenience ─────────────────────── */

/**
 * Normalize an arbitrary date to the first of its UTC month at 00:00. This
 * is the canonical `periodStart` for a payroll period; the half-open end is
 * the first of the NEXT month.
 */
export function normalizeMonth(d: Date): { periodStart: Date; periodEnd: Date } {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return {
    periodStart: new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)),
    periodEnd: new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0)),
  };
}

function compRowToDto(row: EmployeeCompensationRow): CompensationDto {
  return {
    id: row.id,
    employeeId: row.employeeId,
    payType: row.payType as PayType,
    baseSalaryMonthly:
      row.baseSalaryMonthly == null ? null : Number(row.baseSalaryMonthly),
    hourlyRate: row.hourlyRate == null ? null : Number(row.hourlyRate),
    standardMonthlyHours:
      row.standardMonthlyHours == null ? null : Number(row.standardMonthlyHours),
    commissionRate: Number(row.commissionRate ?? "0"),
    commissionBase: (row.commissionBase ?? "gross_sales") as CommissionBase,
    bonusEligible: Boolean(row.bonusEligible),
    effectiveFrom: row.effectiveFrom,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  };
}

function eventRowToDto(row: AttendanceEventRow): AttendanceEventDto {
  return {
    id: row.id,
    employeeId: row.employeeId,
    type: row.type as AttendanceEventDto["type"],
    occurredAt: row.occurredAt,
    source: row.source as AttendanceEventDto["source"],
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    accuracyM: row.accuracyM,
    recordedByUserId: row.recordedByUserId,
    note: row.note,
    requiresReview: row.requiresReview,
  };
}

function adjustmentRowToSnapshot(row: PayrollAdjustmentRow): AdjustmentSnapshot {
  return {
    id: row.id,
    kind: row.kind as AdjustmentSnapshot["kind"],
    amount: Number(row.amount),
    reason: row.reason,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ComputePayrollResult {
  snapshot: PayrollSnapshot;
  compensationSnapshot: CompensationSnapshot | null;
}

/**
 * Compute the live payroll snapshot for one employee + month. Pure read: no
 * writes, no mutations. Runs inside `withTenant` so RLS gates every query.
 */
export async function computePayrollForEmployee(
  tenantId: string,
  employeeId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<ComputePayrollResult> {
  const settings = await getAttendanceSettings(tenantId);

  return withTenant(tenantId, async (tx) => {
    // Pull: compensation history (all rows, newest-first — compute picks per shift)
    //       attendance events in the window
    //       approved leave overlapping the window
    //       non-voided adjustments for this month
    //       grossSales & returnedValue aggregated via SQL
    const compRows = await tx
      .select()
      .from(employeeCompensation)
      .where(
        and(
          eq(employeeCompensation.tenantId, tenantId),
          eq(employeeCompensation.employeeId, employeeId),
        ),
      )
      .orderBy(sql`${employeeCompensation.effectiveFrom} desc`);

    const eventRows = await tx
      .select()
      .from(attendanceEvents)
      .where(
        and(
          eq(attendanceEvents.tenantId, tenantId),
          eq(attendanceEvents.employeeId, employeeId),
          gte(attendanceEvents.occurredAt, periodStart),
          lt(attendanceEvents.occurredAt, periodEnd),
        ),
      );

    const leaveRows = await tx
      .select({
        startDate: leaveRequests.startDate,
        endDate: leaveRequests.endDate,
        kind: leaveRequests.kind,
      })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.tenantId, tenantId),
          eq(leaveRequests.userId, employeeId),
          eq(leaveRequests.status, "approved"),
          // Overlap test for [periodStart, periodEnd):
          //   request.startDate < periodEnd AND request.endDate >= periodStart
          lt(leaveRequests.startDate, periodEnd),
          gte(leaveRequests.endDate, periodStart),
        ),
      );

    const adjRows = await tx
      .select()
      .from(payrollAdjustments)
      .where(
        and(
          eq(payrollAdjustments.tenantId, tenantId),
          eq(payrollAdjustments.employeeId, employeeId),
          eq(payrollAdjustments.periodMonth, periodStart),
          isNull(payrollAdjustments.voidedAt),
        ),
      )
      .orderBy(sql`${payrollAdjustments.createdAt} asc`);

    // Gross sales for the employee in the window.
    const [grossRow] = await tx
      .select({
        total: sql<string>`coalesce(sum(${sales.totalPrice}), 0)::text`,
      })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, tenantId),
          eq(sales.recordedByUserId, employeeId),
          gte(sales.saleDate, periodStart),
          lt(sales.saleDate, periodEnd),
        ),
      );
    const grossSales = Number(grossRow?.total ?? 0);

    // Returned value: join returns → sales where sales.recorded_by_user_id
    // = employee AND return_date in window. Refund per-unit = sale.totalPrice
    // / sale.quantitySold, times returnedQuantity. Casts avoid Postgres int
    // division when quantitySold is 1.
    const [retRow] = await tx
      .select({
        total: sql<string>`
          coalesce(
            sum(
              (${sales.totalPrice}::numeric / NULLIF(${sales.quantitySold}, 0))
              * ${returns.returnedQuantity}
            ),
            0
          )::text
        `,
      })
      .from(returns)
      .innerJoin(sales, eq(sales.id, returns.saleId))
      .where(
        and(
          eq(returns.tenantId, tenantId),
          eq(sales.recordedByUserId, employeeId),
          gte(returns.returnDate, periodStart),
          lt(returns.returnDate, periodEnd),
        ),
      );
    const returnedValue = Number(retRow?.total ?? 0);

    const compensationHistory = compRows.map(compRowToDto);
    const events = eventRows.map(eventRowToDto);
    const approvedLeave = leaveRows.map((r) => ({
      startDate: r.startDate,
      endDate: r.endDate,
      kind: (r.kind as "paid" | "unpaid") ?? "unpaid",
    }));
    const adjustments = adjRows.map(adjustmentRowToSnapshot);

    return composePayrollSnapshot({
      periodStart,
      periodEnd,
      employeeId,
      compensationHistory,
      attendanceEvents: events,
      attendanceSettings: settings,
      approvedLeave,
      adjustments,
      grossSales,
      returnedValue,
    });
  });
}

/**
 * Batch version: compute snapshots for every tenant member in one pass, so
 * the register page doesn't fan out N round trips. Returns in the order
 * given by `employeeIds`.
 */
export async function computePayrollForEmployees(
  tenantId: string,
  employeeIds: string[],
  periodStart: Date,
  periodEnd: Date,
): Promise<ComputePayrollResult[]> {
  // V1 is sequential inside one `withTenant` session. The loop is fine for
  // the handful of employees a small shop has; when this becomes slow we'll
  // switch to one UNION ALL query that groups sales/returns by employee_id.
  const out: ComputePayrollResult[] = [];
  for (const id of employeeIds) {
    out.push(await computePayrollForEmployee(tenantId, id, periodStart, periodEnd));
  }
  return out;
}

/* ─────────────────────── Housekeeping (tenant‐scoped list) ─────────────── */

/**
 * Pull every tenant member who should appear on the register. We expose
 * this here rather than in `lib/repo/payroll.ts` so the engine owns the
 * "who gets a sheet" decision — anyone with an active tenant membership.
 */
export async function listTenantEmployeesForPayroll(
  tenantId: string,
): Promise<Array<{ userId: string; displayName: string | null; role: string }>> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        userId: tenantMembers.userId,
        displayName: tenantMembers.displayName,
        role: tenantMembers.role,
        userName: users.name,
      })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(eq(tenantMembers.tenantId, tenantId))
      .orderBy(sql`coalesce(${tenantMembers.displayName}, ${users.name}) asc`);
    return rows.map((r) => ({
      userId: r.userId,
      displayName: r.displayName ?? r.userName,
      role: r.role,
    }));
  });
}
