import { attendanceSummaryInWindow } from "@/lib/repo/attendance-events";
import { listLeavesInWindow } from "@/lib/repo/leave-requests";
import { listTeamMembers } from "@/lib/repo/team";
import { loadSalesByEmployee } from "@/lib/repo/sales-by-employee";

import type { Tool } from "./types";
import {
  DATE_FROM_SCHEMA,
  DATE_TO_SCHEMA,
  PERIOD_SCHEMA,
  parseIsoDate,
  parseLimit,
  parsePeriod,
  resolveWindow,
  windowFor,
} from "./_shared";

/**
 * HR / employee read tools.
 *
 * Permission policy: all three gate on `manage_team` — owner-only in practice.
 * Staff should not be able to pull another employee's attendance or sales
 * through the chat. If we later add a `view_team` permission we can relax
 * these to that; for W3 the strict gate is correct.
 *
 * Isolation: tenant_id only. Storo has no branch feature — the HR repo
 * helpers accept a legacy branch arg that we pass null for.
 *
 * HARD RULE — RECORDED FACTS ONLY. We expose ONLY what the shop actually
 * recorded:
 *   • Leave rows            → recorded in `leave_requests`
 *   • Hours worked          → closed check_in → check_out pairs, summed
 *   • Days present          → distinct calendar dates with a closed shift
 *   • Open shifts           → unmatched check_ins (forgot to clock out)
 *   • Sales per cashier     → `sales.recordedByUserId` aggregates
 *
 * DO NOT add fields that require inference from a POLICY the shop hasn't
 * configured:
 *   • "Late arrivals" needs attendanceSettings.graceMinutesLate + the shop's
 *     shift start times. Until that policy is modelled per employee, surfacing
 *     "late" would be guessing. Add the policy first, then expose the metric.
 *   • "Absences" needs the expected workday calendar per employee (which days
 *     they were scheduled, which they weren't). Same reasoning.
 *   • "Overtime" needs a daily/weekly contract hours baseline. Same reasoning.
 *
 * If asked for any of these, the agent should answer with the recorded facts
 * it does have (hours, days present, open shifts) and tell the user the
 * missing data isn't configured in Storo yet — never fabricate.
 */

/* --------------------------------------------------- get_employees_on_leave */

export const getEmployeesOnLeave: Tool = {
  name: "get_employees_on_leave",
  description:
    "List employees whose approved leave overlaps a date range. Supports an explicit from/to (ISO yyyy-mm-dd), or a convenience period (today | week | month). Default status is 'approved' only.",
  requiredPermission: "manage_team",
  parameters: {
    type: "object",
    properties: {
      period: {
        type: "string",
        enum: ["today", "yesterday", "week", "month", "quarter", "year"],
        description: "Convenience window. Ignored when `from` + `to` are both set.",
      },
      from: { type: "string", description: "Window start, ISO date (yyyy-mm-dd). Pair with `to`." },
      to: { type: "string", description: "Window end, ISO date (yyyy-mm-dd). Pair with `from`." },
      include_pending: {
        type: "boolean",
        description: "Include pending (un-approved) requests. Default false.",
      },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    let from = parseIsoDate(args.from);
    let to = parseIsoDate(args.to);
    if (!from || !to) {
      const period = parsePeriod(args.period ?? "week");
      const w = windowFor(period);
      if (!w) return { ok: false, error: "RANGE_REQUIRED", reason: "Pass from+to or a period." };
      from = w.from;
      to = w.to;
    }
    const statuses = args.include_pending === true ? ["approved", "pending"] as const : ["approved"] as const;
    const rows = await listLeavesInWindow(ctx.tenantId, {
      branchId: null,
      from,
      to,
      statuses: [...statuses],
    });
    return {
      ok: true,
      data: {
        window: { from: from.toISOString(), to: to.toISOString() },
        count: rows.length,
        leaves: rows.map((r) => ({
          id: r.id,
          userId: r.userId,
          userName: r.userName,
          startDate: r.startDate.toISOString(),
          endDate: r.endDate.toISOString(),
          status: r.status,
          reason: r.reason,
        })),
      },
    };
  },
};

/* ---------------------------------------------- get_attendance_summary */

export const getAttendanceSummary: Tool = {
  name: "get_attendance_summary",
  description:
    "Per-employee attendance roll-up for a period: total hours worked, days present, and open shifts (people who forgot to clock out). Joins each row with the member's display name so the reply doesn't leak raw user IDs.",
  requiredPermission: "manage_team",
  parameters: {
    type: "object",
    properties: {
      period: PERIOD_SCHEMA,
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Max rows to return (default 20)." },
    },
    required: ["period"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const period = parsePeriod(args.period);
    const w = windowFor(period);
    if (!w) return { ok: false, error: "RANGE_REQUIRED", reason: "All-time attendance is not supported — pick today/week/month/quarter/year." };
    const limit = parseLimit(args.limit, 20, 50);
    const [summary, members] = await Promise.all([
      attendanceSummaryInWindow(ctx.tenantId, { from: w.from, to: w.to }),
      listTeamMembers(ctx.tenantId, undefined),
    ]);
    const nameById = new Map(members.map((m) => [m.userId, m.displayName]));
    // Tenant-scoped — Storo has no branch feature, so every member on the
    // roster is in scope.
    const scoped = summary;
    return {
      ok: true,
      data: {
        period,
        window: { from: w.from.toISOString(), to: w.to.toISOString() },
        rows: scoped.slice(0, limit).map((r) => ({
          employeeId: r.employeeId,
          employeeName: nameById.get(r.employeeId) ?? null,
          totalHours: r.totalHours,
          daysPresent: r.daysPresent,
          openShifts: r.openShifts,
        })),
      },
    };
  },
};

/* ----------------------------------------------- get_sales_by_employee */

export const getSalesByEmployee: Tool = {
  name: "get_sales_by_employee",
  description:
    "Per-cashier sales performance for a period: revenue, number of transactions and average order value. Pass a `period` preset OR an explicit `from`+`to` ISO day pair for arbitrary ranges like 'from 1 June to 15 June'. Use for 'who's selling the most', 'top cashier', 'employee sales performance'.",
  requiredPermission: "manage_team",
  parameters: {
    type: "object",
    properties: {
      period: PERIOD_SCHEMA,
      from: DATE_FROM_SCHEMA,
      to: DATE_TO_SCHEMA,
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Max rows to return (default 15)." },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const resolved = resolveWindow(args);
    const w = resolved.window;
    if (!w)
      return {
        ok: false,
        error: "RANGE_REQUIRED",
        reason:
          "All-time sales-by-employee is not supported — pick today/week/month/quarter/year, or pass explicit from/to.",
      };
    const limit = parseLimit(args.limit, 15, 50);
    const rows = await loadSalesByEmployee(ctx.tenantId, {
      branchId: null,
      from: w.from,
      to: w.to,
    });
    return {
      ok: true,
      data: {
        period: resolved.period,
        currency: "EGP",
        window: { from: w.from.toISOString(), to: w.to.toISOString() },
        rows: rows.slice(0, limit),
      },
    };
  },
};
