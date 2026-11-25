// Pure-core tests for the Payroll V1 engine. These exercise
// `composePayrollSnapshot` with hand-built inputs — no Postgres, no mocks.
// The async wrapper (`computePayrollForEmployee`) is covered by the real-
// DB integration tests in Phase 10.
//
// Assertions pin the parts the P&L and PDF depend on:
//   • regular/overtime split from attendance
//   • paid vs unpaid leave day counts
//   • commission math (grossSales − returnedValue) × rate
//   • adjustment sign aggregation
//   • netAmount = gross + commission + adjustmentsTotal
//   • compensationSnapshot shape (what finalize will freeze)
//   • warnings: no_compensation / open_shifts / missing_attendance

import { describe, expect, it } from "vitest";

import {
  composePayrollSnapshot,
  normalizeMonth,
  PAYROLL_CALCULATION_VERSION,
  type AdjustmentSnapshot,
  type ComposePayrollInputs,
} from "@/lib/payroll/engine";
import type { AttendanceEventDto } from "@/lib/repo/attendance-events";
import type { AttendanceSettingsDto } from "@/lib/repo/attendance";
import type { CompensationDto } from "@/lib/repo/payroll-compute";

const DEFAULT_SETTINGS: AttendanceSettingsDto = {
  workHoursPerDay: 8,
  weekendDays: [5, 6],
  overtimeMultiplier: 1.0,
  graceMinutesLate: 0,
};

const MARCH = normalizeMonth(new Date("2026-03-15T00:00:00Z"));

function hourlyComp(rate: number, commissionRate = 0): CompensationDto {
  return {
    id: "comp-1",
    employeeId: "emp-1",
    payType: "hourly",
    baseSalaryMonthly: null,
    hourlyRate: rate,
    standardMonthlyHours: null,
    commissionRate,
    commissionBase: "gross_sales",
    bonusEligible: false,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    createdByUserId: "u-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function fixedComp(monthly: number, commissionRate = 0, bonusEligible = false): CompensationDto {
  return {
    id: "comp-1",
    employeeId: "emp-1",
    payType: "fixed",
    baseSalaryMonthly: monthly,
    hourlyRate: null,
    standardMonthlyHours: null,
    commissionRate,
    commissionBase: "gross_sales",
    bonusEligible,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    createdByUserId: "u-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function checkIn(iso: string): AttendanceEventDto {
  return {
    id: `in-${iso}`,
    employeeId: "emp-1",
    type: "check_in",
    occurredAt: new Date(iso),
    source: "manual",
    latitude: null,
    longitude: null,
    accuracyM: null,
    recordedByUserId: "u-1",
    note: null,
    requiresReview: false,
  };
}
function checkOut(iso: string): AttendanceEventDto {
  return {
    id: `out-${iso}`,
    employeeId: "emp-1",
    type: "check_out",
    occurredAt: new Date(iso),
    source: "manual",
    latitude: null,
    longitude: null,
    accuracyM: null,
    recordedByUserId: "u-1",
    note: null,
    requiresReview: false,
  };
}

function adj(
  kind: AdjustmentSnapshot["kind"],
  amount: number,
  reason = "test",
): AdjustmentSnapshot {
  return {
    id: `adj-${kind}-${amount}`,
    kind,
    amount,
    reason,
    createdByUserId: "u-1",
    createdAt: "2026-03-10T10:00:00.000Z",
  };
}

const EMPTY_INPUTS: ComposePayrollInputs = {
  periodStart: MARCH.periodStart,
  periodEnd: MARCH.periodEnd,
  employeeId: "emp-1",
  compensationHistory: [],
  attendanceEvents: [],
  attendanceSettings: DEFAULT_SETTINGS,
  approvedLeave: [],
  adjustments: [],
  grossSales: 0,
  returnedValue: 0,
};

describe("normalizeMonth", () => {
  it("snaps any date to first-of-month UTC + first-of-next-month end", () => {
    const { periodStart, periodEnd } = normalizeMonth(new Date("2026-03-15T12:34:00Z"));
    expect(periodStart.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(periodEnd.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("handles December year rollover", () => {
    const { periodStart, periodEnd } = normalizeMonth(new Date("2026-12-31T23:59Z"));
    expect(periodStart.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(periodEnd.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("composePayrollSnapshot — empty state", () => {
  it("returns zeros + no_compensation + missing_attendance warnings", () => {
    const { snapshot, compensationSnapshot } = composePayrollSnapshot(EMPTY_INPUTS);
    expect(snapshot.calculationVersion).toBe(PAYROLL_CALCULATION_VERSION);
    expect(snapshot.grossAmount).toBe(0);
    expect(snapshot.commissionAmount).toBe(0);
    expect(snapshot.adjustmentsTotal).toBe(0);
    expect(snapshot.netAmount).toBe(0);
    expect(snapshot.warnings.map((w) => w.code).sort()).toEqual([
      "missing_attendance",
      "no_compensation",
    ]);
    expect(compensationSnapshot).toBeNull();
  });
});

describe("composePayrollSnapshot — attendance", () => {
  it("rolls paired shifts into regular/overtime hours by workday cap", () => {
    // 10 hours on a non-weekend day → 8 regular + 2 overtime
    const events = [
      checkIn("2026-03-02T08:00:00Z"),
      checkOut("2026-03-02T18:00:00Z"),
    ];
    const { snapshot } = composePayrollSnapshot({
      ...EMPTY_INPUTS,
      compensationHistory: [hourlyComp(50)],
      attendanceEvents: events,
    });
    expect(snapshot.regularHours).toBe(8);
    expect(snapshot.overtimeHours).toBe(2);
    expect(snapshot.hourlyEarnings).toBe(8 * 50 + 2 * 50 * 1.0);
    expect(snapshot.grossAmount).toBe(500);
  });

  it("flags open shifts (forgot-to-check-out) via reviewCount + warning", () => {
    const events = [checkIn("2026-03-02T09:00:00Z")]; // no close
    const { snapshot } = composePayrollSnapshot({
      ...EMPTY_INPUTS,
      compensationHistory: [hourlyComp(50)],
      attendanceEvents: events,
    });
    expect(snapshot.reviewCount).toBe(1);
    expect(snapshot.warnings.map((w) => w.code)).toContain("open_shifts");
  });
});

describe("composePayrollSnapshot — leave days", () => {
  it("counts paid vs unpaid days overlapping the period", () => {
    // Paid 2 days (Mar 3,4), unpaid 1 day (Mar 5). Weekends still count as days.
    const { snapshot } = composePayrollSnapshot({
      ...EMPTY_INPUTS,
      compensationHistory: [fixedComp(3100)],
      approvedLeave: [
        {
          startDate: new Date("2026-03-03T00:00:00Z"),
          endDate: new Date("2026-03-04T23:59:59Z"),
          kind: "paid",
        },
        {
          startDate: new Date("2026-03-05T00:00:00Z"),
          endDate: new Date("2026-03-05T23:59:59Z"),
          kind: "unpaid",
        },
      ],
    });
    expect(snapshot.paidLeaveDays).toBe(2);
    expect(snapshot.unpaidLeaveDays).toBe(1);
  });

  it("clips leave windows to the period boundary", () => {
    // Leave spans Feb 25 – Mar 3 (6 days), of which 3 land in March.
    const { snapshot } = composePayrollSnapshot({
      ...EMPTY_INPUTS,
      compensationHistory: [fixedComp(3100)],
      approvedLeave: [
        {
          startDate: new Date("2026-02-25T00:00:00Z"),
          endDate: new Date("2026-03-03T23:59:59Z"),
          kind: "paid",
        },
      ],
    });
    expect(snapshot.paidLeaveDays).toBe(3);
  });
});

describe("composePayrollSnapshot — commission", () => {
  it("computes (grossSales − returnedValue) × commissionRate / 100", () => {
    const { snapshot } = composePayrollSnapshot({
      ...EMPTY_INPUTS,
      compensationHistory: [hourlyComp(0, 5)], // 5% commission
      grossSales: 10_000,
      returnedValue: 2_000,
    });
    expect(snapshot.commissionGrossSales).toBe(10_000);
    expect(snapshot.commissionReturnedValue).toBe(2_000);
    expect(snapshot.commissionNetSales).toBe(8_000);
    expect(snapshot.commissionAmount).toBe(400);
  });

  it("clamps negative net sales to 0 — returns can't create negative commission", () => {
    const { snapshot } = composePayrollSnapshot({
      ...EMPTY_INPUTS,
      compensationHistory: [hourlyComp(0, 10)],
      grossSales: 500,
      returnedValue: 900,
    });
    expect(snapshot.commissionNetSales).toBe(0);
    expect(snapshot.commissionAmount).toBe(0);
  });

  it("emits no_sales_attribution when rate > 0 but grossSales = 0", () => {
    const { snapshot } = composePayrollSnapshot({
      ...EMPTY_INPUTS,
      compensationHistory: [hourlyComp(0, 5)],
      grossSales: 0,
    });
    expect(snapshot.warnings.map((w) => w.code)).toContain("no_sales_attribution");
  });

  it("stays at 0 when commissionRate = 0", () => {
    const { snapshot } = composePayrollSnapshot({
      ...EMPTY_INPUTS,
      compensationHistory: [fixedComp(3100, 0)],
      grossSales: 50_000,
    });
    expect(snapshot.commissionAmount).toBe(0);
  });
});

describe("composePayrollSnapshot — adjustments", () => {
  it("sums signed amounts into adjustmentsTotal and includes them in the net", () => {
    const { snapshot } = composePayrollSnapshot({
      ...EMPTY_INPUTS,
      compensationHistory: [fixedComp(3100)],
      attendanceEvents: [
        checkIn("2026-03-02T09:00:00Z"),
        checkOut("2026-03-02T17:00:00Z"),
      ],
      adjustments: [
        adj("bonus", 500),
        adj("deduction", -150),
        adj("advance_repayment", -100),
      ],
    });
    expect(snapshot.adjustmentsTotal).toBe(250); // 500 − 150 − 100
    // netAmount = grossAmount + commissionAmount + adjustmentsTotal
    expect(snapshot.netAmount).toBe(snapshot.grossAmount + snapshot.adjustmentsTotal);
  });
});

describe("composePayrollSnapshot — compensationSnapshot", () => {
  it("freezes the primary compensation row at period start", () => {
    const comp = fixedComp(3200, 5, true);
    const { compensationSnapshot } = composePayrollSnapshot({
      ...EMPTY_INPUTS,
      compensationHistory: [comp],
    });
    expect(compensationSnapshot).toMatchObject({
      id: "comp-1",
      payType: "fixed",
      baseSalaryMonthly: 3200,
      commissionRate: 5,
      commissionBase: "gross_sales",
      bonusEligible: true,
      effectiveFrom: comp.effectiveFrom.toISOString(),
    });
  });

  it("returns null when no comp row is effective at period start", () => {
    const futureComp = {
      ...fixedComp(3000),
      effectiveFrom: new Date("2026-05-01T00:00:00Z"),
    };
    const { compensationSnapshot } = composePayrollSnapshot({
      ...EMPTY_INPUTS,
      compensationHistory: [futureComp],
    });
    expect(compensationSnapshot).toBeNull();
  });
});
