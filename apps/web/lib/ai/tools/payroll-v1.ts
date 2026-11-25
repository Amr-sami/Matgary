// Payroll V1 — AI Agent tools.
//
// READS (authoritative — always go through the payroll service, never do math
// in-agent):
//   • list_payroll_sheet(month)      → full register for one month
//   • get_employee_payroll(userId, month) → one employee's sheet
//
// STAGED WRITES (F5 pipeline — HMAC + TTL + atomic consume + secondary
// permission check at confirm):
//   • preview_calculate_payroll            (manage_payroll)
//   • preview_finalize_payroll             (manage_payroll)
//   • preview_update_compensation          (manage_payroll)
//   • preview_toggle_bonus_eligibility     (manage_payroll)
//   • preview_add_payroll_adjustment       (manage_payroll)
//
// Every write tool:
//   1. Validates args shape + employee existence.
//   2. Resolves the live sheet (or compensation row) to populate the preview
//      block with REAL numbers the Owner is about to commit.
//   3. Calls createPending(action, params, preview) — returns a token.
//   4. Returns `{ ok:true, blocks:[confirmation block], data:{token}}`.
//
// Execution lives in lib/ai/write/execute.ts; the confirm route re-checks
// `manage_payroll` from an ACTION_PERMISSION map, atomic-consumes the token,
// and calls the authoritative repo method.

import { and, desc, eq } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { employeeCompensation, tenantMembers, users } from "@/lib/db/schema";
import { createPending } from "@/lib/ai/write/pending";
import { normalizeMonth } from "@/lib/payroll/engine";
import {
  getEmployeePayrollMonth,
  listPayrollMonth,
} from "@/lib/repo/payroll-periods";

import type { Tool } from "./types";

const MONTH_SHAPE = /^\d{4}-\d{2}$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseMonth(value: unknown): Date | null {
  if (typeof value !== "string" || !MONTH_SHAPE.test(value)) return null;
  const [y, m] = value.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  return new Date(Date.UTC(y!, m! - 1, 1, 0, 0, 0, 0));
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ──────────────────────────── Read tools ─────────────────────────────── */

export const listPayrollSheet: Tool = {
  name: "list_payroll_sheet",
  description:
    "Authoritative monthly payroll register — one row per tenant member for the given month. Returns the live snapshot (regular/overtime hours, base/hourly/commission/adjustments/net), lifecycle (MISSING/DRAFT/FINALIZED/VOIDED), and any warnings. Never compute salary yourself — read it from here. Requires `manage_payroll`.",
  requiredPermission: "manage_payroll",
  parameters: {
    type: "object",
    properties: {
      month: {
        type: "string",
        description: "YYYY-MM. Examples: 2026-03, 2026-11.",
      },
    },
    required: ["month"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const periodStart = parseMonth(args.month);
    if (!periodStart) return { ok: false, error: "INVALID_MONTH" };
    const rows = await listPayrollMonth(ctx.tenantId, periodStart);
    return {
      ok: true,
      data: {
        month: args.month,
        rows: rows.map((r) => ({
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          role: r.role,
          lifecycle: r.lifecycle,
          periodId: r.periodId,
          snapshot: r.snapshot,
          finalizedAt: r.finalizedAt,
          voidedAt: r.voidedAt,
        })),
      },
    };
  },
};

export const getEmployeePayrollTool: Tool = {
  name: "get_employee_payroll",
  description:
    "One employee's payroll sheet for one month. Includes compensationSnapshot (the pay rules in force at period start, frozen for finalized rows) and the full breakdown — attendance, leave, earnings, commission, adjustments, net, warnings. Use this when the user asks why a specific employee's pay is what it is. Requires `manage_payroll`.",
  requiredPermission: "manage_payroll",
  parameters: {
    type: "object",
    properties: {
      employeeId: { type: "string", description: "uuid" },
      month: { type: "string", description: "YYYY-MM" },
    },
    required: ["employeeId", "month"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    if (typeof args.employeeId !== "string" || !UUID_SHAPE.test(args.employeeId))
      return { ok: false, error: "INVALID_EMPLOYEE_ID" };
    const periodStart = parseMonth(args.month);
    if (!periodStart) return { ok: false, error: "INVALID_MONTH" };
    const sheet = await getEmployeePayrollMonth(ctx.tenantId, args.employeeId, periodStart);
    if (!sheet) return { ok: false, error: "NOT_FOUND" };
    return { ok: true, data: { sheet } };
  },
};

/* ──────────────────────────── Write tools ────────────────────────────── */

/** Resolve the display name — the pending preview needs a human label. */
async function resolveEmployeeName(
  tenantId: string,
  employeeId: string,
): Promise<string | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        displayName: tenantMembers.displayName,
        userName: users.name,
      })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, employeeId)))
      .limit(1);
    return row ? (row.displayName ?? row.userName) : null;
  });
}

export const previewCalculatePayroll: Tool = {
  name: "preview_calculate_payroll",
  description:
    "Stage a DRAFT payroll calculation for ONE employee + month. Idempotent. The confirmation shows the live computed net the Owner is about to save. Does NOT finalize — a separate preview_finalize_payroll is required. Requires `manage_payroll`.",
  requiredPermission: "manage_payroll",
  parameters: {
    type: "object",
    properties: {
      employeeId: { type: "string", description: "uuid" },
      month: { type: "string", description: "YYYY-MM" },
    },
    required: ["employeeId", "month"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    if (typeof args.employeeId !== "string" || !UUID_SHAPE.test(args.employeeId))
      return { ok: false, error: "INVALID_EMPLOYEE_ID" };
    const periodStart = parseMonth(args.month);
    if (!periodStart) return { ok: false, error: "INVALID_MONTH" };
    const sheet = await getEmployeePayrollMonth(ctx.tenantId, args.employeeId, periodStart);
    if (!sheet) return { ok: false, error: "NOT_FOUND" };
    const name = sheet.employeeName ?? (await resolveEmployeeName(ctx.tenantId, args.employeeId));
    const token = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "payroll_calculate",
      params: { employeeId: args.employeeId, month: args.month },
      preview: {
        employeeId: args.employeeId,
        employeeName: name,
        month: args.month,
        liveGross: sheet.snapshot.grossAmount,
        liveCommission: sheet.snapshot.commissionAmount,
        liveAdjustments: sheet.snapshot.adjustmentsTotal,
        liveNet: sheet.snapshot.netAmount,
        currentLifecycle: sheet.lifecycle,
      },
    });
    return {
      ok: true,
      blocks: [
        {
          kind: "confirmation",
          title: `Save draft payroll for ${name ?? "employee"} — ${args.month}`,
          summary: `Net = ${fmtMoney(sheet.snapshot.netAmount)} EGP (gross ${fmtMoney(
            sheet.snapshot.grossAmount,
          )} + commission ${fmtMoney(sheet.snapshot.commissionAmount)} + adjustments ${fmtMoney(
            sheet.snapshot.adjustmentsTotal,
          )}).`,
          actionLabel: "Save draft",
          token: token.token,
          expiresAt: token.expiresAt,
        },
      ],
    };
  },
};

export const previewFinalizePayroll: Tool = {
  name: "preview_finalize_payroll",
  description:
    "Stage finalization of ONE employee + month. Finalizing freezes the snapshot — later edits to compensation / attendance / sales will NOT retroactively change this sheet, and the row is immediately included in the P&L's People → Salaries line. Blocked if the sheet is already FINALIZED (void first). Requires `manage_payroll`.",
  requiredPermission: "manage_payroll",
  parameters: {
    type: "object",
    properties: {
      employeeId: { type: "string", description: "uuid" },
      month: { type: "string", description: "YYYY-MM" },
    },
    required: ["employeeId", "month"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    if (typeof args.employeeId !== "string" || !UUID_SHAPE.test(args.employeeId))
      return { ok: false, error: "INVALID_EMPLOYEE_ID" };
    const periodStart = parseMonth(args.month);
    if (!periodStart) return { ok: false, error: "INVALID_MONTH" };
    const sheet = await getEmployeePayrollMonth(ctx.tenantId, args.employeeId, periodStart);
    if (!sheet) return { ok: false, error: "NOT_FOUND" };
    if (sheet.lifecycle === "FINALIZED")
      return { ok: false, error: "ALREADY_FINALIZED" };
    const name = sheet.employeeName ?? (await resolveEmployeeName(ctx.tenantId, args.employeeId));
    const warnings = sheet.snapshot.warnings.map((w) => w.message);
    const token = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "payroll_finalize",
      params: { employeeId: args.employeeId, month: args.month },
      preview: {
        employeeId: args.employeeId,
        employeeName: name,
        month: args.month,
        netAmount: sheet.snapshot.netAmount,
        grossAmount: sheet.snapshot.grossAmount,
        commissionAmount: sheet.snapshot.commissionAmount,
        adjustmentsTotal: sheet.snapshot.adjustmentsTotal,
        warnings,
      },
    });
    return {
      ok: true,
      blocks: [
        {
          kind: "confirmation",
          title: `Finalize payroll for ${name ?? "employee"} — ${args.month}`,
          summary:
            `Net ${fmtMoney(sheet.snapshot.netAmount)} EGP. Finalizing freezes the sheet and rolls it into the P&L.` +
            (warnings.length > 0 ? ` ⚠ ${warnings.length} warning(s): ${warnings.join("; ")}` : ""),
          actionLabel: "Finalize",
          token: token.token,
          expiresAt: token.expiresAt,
        },
      ],
    };
  },
};

export const previewUpdateCompensation: Tool = {
  name: "preview_update_compensation",
  description:
    "Stage a new compensation row for an employee (versioned — does NOT retroactively change finalized sheets). Use to change pay type, base salary, hourly rate, commission %, or bonus eligibility. Pass only the fields that should change; the rest carry forward from the current row. Requires `manage_payroll`.",
  requiredPermission: "manage_payroll",
  parameters: {
    type: "object",
    properties: {
      employeeId: { type: "string", description: "uuid" },
      payType: { type: "string", enum: ["fixed", "hourly", "hybrid"] },
      baseSalaryMonthly: { type: "number", minimum: 0 },
      hourlyRate: { type: "number", minimum: 0 },
      commissionRate: { type: "number", minimum: 0, maximum: 100 },
      bonusEligible: { type: "boolean" },
      effectiveFrom: {
        type: "string",
        description: "ISO date (YYYY-MM-DD). Defaults to today.",
      },
    },
    required: ["employeeId"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    if (typeof args.employeeId !== "string" || !UUID_SHAPE.test(args.employeeId))
      return { ok: false, error: "INVALID_EMPLOYEE_ID" };
    // Load the current row to fill in defaults AND to echo back in the preview.
    const current = await withTenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(employeeCompensation)
        .where(
          and(
            eq(employeeCompensation.tenantId, ctx.tenantId),
            eq(employeeCompensation.employeeId, args.employeeId as string),
          ),
        )
        .orderBy(desc(employeeCompensation.effectiveFrom))
        .limit(1);
      return row ?? null;
    });
    const name = await resolveEmployeeName(ctx.tenantId, args.employeeId);
    if (!name) return { ok: false, error: "NOT_FOUND" };

    const payType =
      typeof args.payType === "string" ? args.payType : (current?.payType ?? "fixed");
    const baseSalaryMonthly =
      typeof args.baseSalaryMonthly === "number"
        ? args.baseSalaryMonthly
        : current
          ? Number(current.baseSalaryMonthly ?? 0)
          : null;
    const hourlyRate =
      typeof args.hourlyRate === "number"
        ? args.hourlyRate
        : current
          ? Number(current.hourlyRate ?? 0)
          : null;
    const commissionRate =
      typeof args.commissionRate === "number"
        ? args.commissionRate
        : current
          ? Number(current.commissionRate ?? "0")
          : 0;
    const bonusEligible =
      typeof args.bonusEligible === "boolean"
        ? args.bonusEligible
        : Boolean(current?.bonusEligible);
    const effectiveFrom =
      typeof args.effectiveFrom === "string" ? args.effectiveFrom : new Date().toISOString();

    const token = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "payroll_update_compensation",
      params: {
        employeeId: args.employeeId,
        payType,
        baseSalaryMonthly,
        hourlyRate,
        commissionRate,
        bonusEligible,
        effectiveFrom,
      },
      preview: {
        employeeId: args.employeeId,
        employeeName: name,
        payType,
        baseSalaryMonthly,
        hourlyRate,
        commissionRate,
        bonusEligible,
        effectiveFrom,
      },
    });
    return {
      ok: true,
      blocks: [
        {
          kind: "confirmation",
          title: `Update compensation for ${name}`,
          summary: `New rule effective ${effectiveFrom.slice(0, 10)}: ${payType}${
            baseSalaryMonthly ? `, base ${fmtMoney(baseSalaryMonthly)}` : ""
          }${hourlyRate ? `, ${fmtMoney(hourlyRate)}/h` : ""}${
            commissionRate > 0 ? `, ${commissionRate}% commission` : ""
          }, bonuses ${bonusEligible ? "ON" : "OFF"}. Already-finalized months are NOT changed.`,
          actionLabel: "Save",
          token: token.token,
          expiresAt: token.expiresAt,
        },
      ],
    };
  },
};

export const previewToggleBonusEligibility: Tool = {
  name: "preview_toggle_bonus_eligibility",
  description:
    "Stage a toggle of the bonus-eligibility flag for an employee. Creates a new compensation row carrying forward the existing rules with only the flag flipped. Requires `manage_payroll`.",
  requiredPermission: "manage_payroll",
  parameters: {
    type: "object",
    properties: {
      employeeId: { type: "string", description: "uuid" },
      bonusEligible: { type: "boolean" },
    },
    required: ["employeeId", "bonusEligible"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    if (typeof args.employeeId !== "string" || !UUID_SHAPE.test(args.employeeId))
      return { ok: false, error: "INVALID_EMPLOYEE_ID" };
    if (typeof args.bonusEligible !== "boolean")
      return { ok: false, error: "INVALID_FLAG" };
    // Delegate to the full-compensation preview so both tools have a single
    // execution branch. The executor sees the same `payroll_update_compensation`
    // action with every field carried forward except the toggle.
    return previewUpdateCompensation.handler(ctx, {
      employeeId: args.employeeId,
      bonusEligible: args.bonusEligible,
    });
  },
};

export const previewAddPayrollAdjustment: Tool = {
  name: "preview_add_payroll_adjustment",
  description:
    "Stage a bonus or deduction for an employee's current month. Positive `amount` = bonus, negative = deduction. Blocked if the month's payroll is already FINALIZED (the Owner must void before edits). Requires `manage_payroll`.",
  requiredPermission: "manage_payroll",
  parameters: {
    type: "object",
    properties: {
      employeeId: { type: "string", description: "uuid" },
      month: { type: "string", description: "YYYY-MM" },
      kind: {
        type: "string",
        enum: ["bonus", "deduction", "advance_repayment", "correction"],
      },
      amount: { type: "number", description: "Signed. Positive bonus / negative deduction." },
      reason: { type: "string", maxLength: 500 },
    },
    required: ["employeeId", "month", "kind", "amount"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    if (typeof args.employeeId !== "string" || !UUID_SHAPE.test(args.employeeId))
      return { ok: false, error: "INVALID_EMPLOYEE_ID" };
    const periodStart = parseMonth(args.month);
    if (!periodStart) return { ok: false, error: "INVALID_MONTH" };
    if (typeof args.amount !== "number" || !Number.isFinite(args.amount) || args.amount === 0)
      return { ok: false, error: "INVALID_AMOUNT" };
    const kind = String(args.kind ?? "") as
      | "bonus"
      | "deduction"
      | "advance_repayment"
      | "correction";
    if (!["bonus", "deduction", "advance_repayment", "correction"].includes(kind))
      return { ok: false, error: "INVALID_KIND" };
    // Sign check mirrors the DB CHECK.
    if (kind === "bonus" && args.amount <= 0) return { ok: false, error: "BONUS_MUST_BE_POSITIVE" };
    if ((kind === "deduction" || kind === "advance_repayment") && args.amount >= 0)
      return { ok: false, error: `${kind.toUpperCase()}_MUST_BE_NEGATIVE` };

    const sheet = await getEmployeePayrollMonth(ctx.tenantId, args.employeeId, periodStart);
    if (!sheet) return { ok: false, error: "NOT_FOUND" };
    if (sheet.lifecycle === "FINALIZED")
      return { ok: false, error: "ALREADY_FINALIZED" };

    const name = sheet.employeeName ?? (await resolveEmployeeName(ctx.tenantId, args.employeeId));
    const reason = typeof args.reason === "string" ? args.reason : null;
    const { periodStart: normalized } = normalizeMonth(periodStart);

    const token = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "payroll_add_adjustment",
      params: {
        employeeId: args.employeeId,
        month: args.month,
        periodMonth: normalized.toISOString(),
        kind,
        amount: args.amount,
        reason,
      },
      preview: {
        employeeId: args.employeeId,
        employeeName: name,
        month: args.month,
        kind,
        amount: args.amount,
        reason,
      },
    });
    const sign = args.amount >= 0 ? "+" : "−";
    return {
      ok: true,
      blocks: [
        {
          kind: "confirmation",
          title: `${kind === "bonus" ? "Add bonus" : "Add deduction"} for ${name ?? "employee"} — ${args.month}`,
          summary: `${sign}${fmtMoney(Math.abs(args.amount))} EGP${reason ? ` — ${reason}` : ""}`,
          actionLabel: "Save",
          token: token.token,
          expiresAt: token.expiresAt,
        },
      ],
    };
  },
};
