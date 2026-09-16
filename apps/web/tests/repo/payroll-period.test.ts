import { describe, expect, it } from "vitest";
import { computeGrossFromShifts } from "@/lib/repo/payroll-compute";
import type { CompensationDto } from "@/lib/repo/payroll-compute";
import type { Shift } from "@/lib/repo/attendance-events";
import type { AttendanceSettingsDto } from "@/lib/repo/attendance";

// Egyptian default: weekends = Fri (5) + Sat (6), 8-hour standard day,
// 1.0× overtime multiplier. Matches lib/repo/attendance.ts DEFAULT_SETTINGS.
const DEFAULT_SETTINGS: AttendanceSettingsDto = {
  workHoursPerDay: 8,
  weekendDays: [5, 6],
  overtimeMultiplier: 1.0,
  graceMinutesLate: 0,
};

function shift(start: string, end: string | null, requiresReview = false): Shift {
  const s = new Date(start);
  const e = end ? new Date(end) : null;
  return {
    start: s,
    end: e,
    hours: e ? (e.getTime() - s.getTime()) / 3_600_000 : 0,
    requiresReview,
  };
}

function comp(
  payType: "fixed" | "hourly" | "hybrid",
  effective: string,
  opts: { base?: number; hourly?: number } = {},
): CompensationDto {
  return {
    id: `comp-${effective}-${payType}`,
    employeeId: "emp-1",
    payType,
    baseSalaryMonthly: opts.base ?? null,
    hourlyRate: opts.hourly ?? null,
    standardMonthlyHours: null,
    effectiveFrom: new Date(effective),
    createdByUserId: "user-1",
    createdAt: new Date(effective),
  };
}

describe("computeGrossFromShifts — empty + degenerate cases", () => {
  it("returns all zeros when there are no shifts", () => {
    const r = computeGrossFromShifts([], [], DEFAULT_SETTINGS);
    expect(r).toEqual({
      regularHours: 0,
      overtimeHours: 0,
      reviewCount: 0,
      baseEarnings: 0,
      hourlyEarnings: 0,
      grossAmount: 0,
    });
  });

  it("ignores open shifts (no end timestamp) — counted as 0 hours", () => {
    const shifts = [shift("2026-06-01T09:00:00Z", null)];
    const r = computeGrossFromShifts(shifts, [], DEFAULT_SETTINGS);
    expect(r.regularHours).toBe(0);
    expect(r.overtimeHours).toBe(0);
  });

  it("counts shifts flagged for manager review", () => {
    const shifts = [
      shift("2026-06-01T09:00:00Z", "2026-06-01T17:00:00Z", true),
      shift("2026-06-02T09:00:00Z", "2026-06-02T17:00:00Z", false),
    ];
    const r = computeGrossFromShifts(shifts, [], DEFAULT_SETTINGS);
    expect(r.reviewCount).toBe(1);
  });
});

describe("computeGrossFromShifts — hourly pay", () => {
  it("returns 0 earnings with no attendance even if a comp row exists", () => {
    const history = [comp("hourly", "2026-01-01", { hourly: 50 })];
    const r = computeGrossFromShifts([], history, DEFAULT_SETTINGS);
    expect(r.hourlyEarnings).toBe(0);
    expect(r.grossAmount).toBe(0);
  });

  it("pays regular hours at the hourly rate on a normal weekday", () => {
    // 2026-06-01 is a Monday → not a weekend day.
    const history = [comp("hourly", "2026-01-01", { hourly: 50 })];
    const shifts = [
      shift("2026-06-01T09:00:00Z", "2026-06-01T17:00:00Z"), // 8 h regular
    ];
    const r = computeGrossFromShifts(shifts, history, DEFAULT_SETTINGS);
    expect(r.regularHours).toBe(8);
    expect(r.overtimeHours).toBe(0);
    expect(r.hourlyEarnings).toBe(400);
  });

  it("pays the overtime hours at the configured multiplier", () => {
    // 10-hour weekday shift: 8 regular + 2 overtime.
    const history = [comp("hourly", "2026-01-01", { hourly: 50 })];
    const shifts = [
      shift("2026-06-01T08:00:00Z", "2026-06-01T18:00:00Z"),
    ];
    const settings = { ...DEFAULT_SETTINGS, overtimeMultiplier: 1.5 };
    const r = computeGrossFromShifts(shifts, history, settings);
    expect(r.regularHours).toBe(8);
    expect(r.overtimeHours).toBe(2);
    // 8 × 50 + 2 × 50 × 1.5 = 400 + 150 = 550
    expect(r.hourlyEarnings).toBe(550);
  });

  it("treats all weekend hours as overtime", () => {
    // 2026-06-05 is a Friday → weekend (day 5).
    const history = [comp("hourly", "2026-01-01", { hourly: 50 })];
    const shifts = [
      shift("2026-06-05T09:00:00Z", "2026-06-05T17:00:00Z"), // 8 weekend hours
    ];
    const settings = { ...DEFAULT_SETTINGS, overtimeMultiplier: 2.0 };
    const r = computeGrossFromShifts(shifts, history, settings);
    expect(r.regularHours).toBe(0);
    expect(r.overtimeHours).toBe(8);
    // 0 regular + 8 × 50 × 2.0 = 800
    expect(r.hourlyEarnings).toBe(800);
  });
});

describe("computeGrossFromShifts — fixed monthly", () => {
  it("pro-rates the monthly base by days worked / days in the month", () => {
    // June 2026 has 30 days. Worked 10 days → 10/30 of 9000 = 3000.
    const history = [comp("fixed", "2026-01-01", { base: 9000 })];
    const shifts: Shift[] = [];
    for (let d = 1; d <= 10; d++) {
      const dd = String(d).padStart(2, "0");
      // Pick Mondays — irrelevant for "fixed" weekend handling because base
      // accrues per day-with-any-hours regardless of weekend/weekday status.
      shifts.push(
        shift(
          `2026-06-${dd}T09:00:00Z`,
          `2026-06-${dd}T17:00:00Z`,
        ),
      );
    }
    const r = computeGrossFromShifts(shifts, history, DEFAULT_SETTINGS);
    expect(r.baseEarnings).toBe(3000);
    expect(r.hourlyEarnings).toBe(0);
    expect(r.grossAmount).toBe(3000);
  });
});

describe("computeGrossFromShifts — hybrid", () => {
  it("pays base monthly pro-rated + overtime hourly", () => {
    const history = [
      comp("hybrid", "2026-01-01", { base: 6000, hourly: 40 }),
    ];
    // 2 weekdays with 10 h each → 16 regular + 4 overtime.
    const shifts = [
      shift("2026-06-01T08:00:00Z", "2026-06-01T18:00:00Z"),
      shift("2026-06-02T08:00:00Z", "2026-06-02T18:00:00Z"),
    ];
    const r = computeGrossFromShifts(shifts, history, DEFAULT_SETTINGS);
    expect(r.regularHours).toBe(16);
    expect(r.overtimeHours).toBe(4);
    // base: 2 days × 6000 / 30 = 400
    expect(r.baseEarnings).toBe(400);
    // overtime only: 4 × 40 × 1.0 = 160
    expect(r.hourlyEarnings).toBe(160);
    expect(r.grossAmount).toBe(560);
  });
});

describe("computeGrossFromShifts — mid-period rate change", () => {
  it("honours the comp row effective on each shift's day", () => {
    // Two compensations: rate 30 from May 1, raise to 60 from Jun 15.
    const history: CompensationDto[] = [
      comp("hourly", "2026-06-15", { hourly: 60 }),
      comp("hourly", "2026-05-01", { hourly: 30 }),
    ];
    const shifts = [
      // Pre-raise: 2026-06-10 (Wed) — 8 h × 30 = 240
      shift("2026-06-10T09:00:00Z", "2026-06-10T17:00:00Z"),
      // Post-raise: 2026-06-20 (Sat → weekend → OT) — 8 h × 60 × 1.0 = 480
      // But 06-20 is Saturday; weekendDays includes 6 (Saturday). All OT.
      shift("2026-06-20T09:00:00Z", "2026-06-20T17:00:00Z"),
    ];
    const r = computeGrossFromShifts(shifts, history, DEFAULT_SETTINGS);
    expect(r.regularHours).toBe(8); // only Wed counts as regular
    expect(r.overtimeHours).toBe(8); // Sat is all OT
    // pre: 8 × 30 = 240; post: 0 regular + 8 × 60 × 1.0 = 480
    expect(r.hourlyEarnings).toBe(720);
  });
});
