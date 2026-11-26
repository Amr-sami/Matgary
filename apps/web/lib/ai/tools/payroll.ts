// Payroll awareness for the Agent. READ-ONLY by design: payroll creation /
// finalization lives on dedicated screens with their own business logic, and
// the Agent must never finalize payroll inferentially. This tool answers
// "what does payroll look like this month?" and surfaces the P&L split:
//   - finalized rows → sum contributes to operating expenses
//   - draft rows    → excluded from P&L (shown separately so the Owner knows
//                      there is work in progress).

import { and, eq, gte, lt } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { payrollPeriods, users } from "@/lib/db/schema";
import {
  DEFAULT_REPORTING_TZ,
  isDatePresetKey,
  resolvePreset,
  type DatePresetKey,
} from "@/lib/finance/dates";

import type { Tool } from "./types";

function parsePreset(v: unknown): DatePresetKey {
  return isDatePresetKey(v) ? v : "this_month";
}

export const getPayrollSummary: Tool = {
  name: "get_payroll_summary",
  description:
    "Read-only payroll snapshot for a period. Separates FINALIZED payroll (contributes to operating expenses — matches what P&L sees) from DRAFT payroll (NOT in P&L). Returns per-row {employee, periodEnd, grossAmount, adjustmentsAmount, status, total} and roll-up totals. Requires view_financials because payroll totals are financial.",
  requiredPermission: "view_financials",
  parameters: {
    type: "object",
    properties: {
      preset: {
        type: "string",
        enum: [
          "today",
          "yesterday",
          "this_week",
          "last_week",
          "this_month",
          "last_month",
          "this_year",
          "last_7_days",
          "last_30_days",
          "custom",
        ],
      },
      from: { type: "string" },
      to: { type: "string" },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const preset = parsePreset(args.preset);
    const period = resolvePreset(preset, {
      tz: DEFAULT_REPORTING_TZ,
      customFrom: typeof args.from === "string" ? args.from : undefined,
      customTo: typeof args.to === "string" ? args.to : undefined,
    });
    const rows = await withTenant(ctx.tenantId, async (tx) =>
      tx
        .select({
          id: payrollPeriods.id,
          employeeId: payrollPeriods.employeeId,
          employeeName: users.name,
          periodEnd: payrollPeriods.periodEnd,
          grossAmount: payrollPeriods.grossAmount,
          adjustmentsAmount: payrollPeriods.adjustmentsAmount,
          status: payrollPeriods.status,
        })
        .from(payrollPeriods)
        .leftJoin(users, eq(users.id, payrollPeriods.employeeId))
        .where(
          and(
            eq(payrollPeriods.tenantId, ctx.tenantId),
            // Match by periodStart so both pre-V1 (periodEnd=last-moment-of-month)
            // and V1 (periodEnd=first-of-next-month) rows land in the same
            // reporting window.
            gte(payrollPeriods.periodStart, period.from),
            lt(payrollPeriods.periodStart, period.to),
          ),
        ),
    );

    let finalizedTotal = 0;
    let draftTotal = 0;
    let finalizedCount = 0;
    let draftCount = 0;
    const safeNum = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const items = rows.map((r) => {
      const total = safeNum(r.grossAmount) + safeNum(r.adjustmentsAmount);
      if (r.status === "finalized") {
        finalizedTotal += total;
        finalizedCount += 1;
      } else {
        draftTotal += total;
        draftCount += 1;
      }
      return {
        id: r.id,
        employeeId: r.employeeId,
        employeeName: r.employeeName ?? null,
        periodEnd: r.periodEnd.toISOString(),
        grossAmount: safeNum(r.grossAmount),
        adjustmentsAmount: safeNum(r.adjustmentsAmount),
        status: r.status as "draft" | "finalized",
        total,
      };
    });

    return {
      ok: true,
      data: {
        preset,
        currency: "EGP",
        note:
          "Finalized payroll contributes to operating expenses (People → Salaries). Draft payroll is EXCLUDED from P&L.",
        finalized: {
          count: finalizedCount,
          total: finalizedTotal,
          contributesToPnL: true,
        },
        draft: {
          count: draftCount,
          total: draftTotal,
          contributesToPnL: false,
        },
        rows: items,
      },
    };
  },
};
