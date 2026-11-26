// Payroll V1 — mobile-facing API client wrappers.
//
// Thin passthrough to apps/web/app/api/payroll/**. All routes are gated by
// `manage_payroll` server-side; the client never calculates salary locally.
// Mobile UX uses these for: the register, employee detail, and the light
// writes (bonus / deduction, compensation toggles, adjustment void). Whole-
// period finalize stays a web workflow in V1 — this module intentionally
// exposes a finalize call so an AI-triggered confirmation can run it too,
// but the mobile UI does NOT surface it.

import type { ApiClient } from "../http";

export type PayrollLifecycle = "MISSING" | "DRAFT" | "FINALIZED" | "VOIDED";

export interface PayrollSnapshotAdjustment {
  id: string;
  kind: "bonus" | "deduction" | "advance_repayment" | "correction";
  amount: number;
  reason: string | null;
  createdByUserId: string;
  createdAt: string;
}

export interface PayrollWarning {
  code: string;
  message: string;
}

export interface PayrollSnapshot {
  calculationVersion: number;
  periodStart: string;
  periodEnd: string;
  employeeId: string;
  regularHours: number;
  overtimeHours: number;
  reviewCount: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  payType: "fixed" | "hourly" | "hybrid";
  baseEarnings: number;
  hourlyEarnings: number;
  grossAmount: number;
  commissionBase: "gross_sales" | "profit_contribution";
  commissionRate: number;
  commissionGrossSales: number;
  commissionReturnedValue: number;
  commissionNetSales: number;
  commissionAmount: number;
  adjustments: PayrollSnapshotAdjustment[];
  adjustmentsTotal: number;
  netAmount: number;
  warnings: PayrollWarning[];
}

export interface CompensationSnapshot {
  id: string;
  payType: "fixed" | "hourly" | "hybrid";
  baseSalaryMonthly: number | null;
  hourlyRate: number | null;
  standardMonthlyHours: number | null;
  commissionRate: number;
  commissionBase: "gross_sales" | "profit_contribution";
  bonusEligible: boolean;
  effectiveFrom: string;
}

export interface PayrollSheet {
  employeeId: string;
  employeeName: string | null;
  role: string;
  lifecycle: PayrollLifecycle;
  periodId: string | null;
  periodStart: string;
  periodEnd: string;
  snapshot: PayrollSnapshot;
  compensationSnapshot: CompensationSnapshot | null;
  finalizedAt: string | null;
  finalizedByUserId: string | null;
  voidedAt: string | null;
  voidedByUserId: string | null;
  voidReason: string | null;
}

export interface PayrollAdjustmentRow {
  id: string;
  employeeId: string;
  periodMonth: string;
  kind: "bonus" | "deduction" | "advance_repayment" | "correction";
  amount: number;
  reason: string | null;
  createdAt: string;
  createdByUserId: string;
}

/** Register for a month across every tenant member. */
export async function listPayrollMonth(
  c: ApiClient,
  month: string, // YYYY-MM
): Promise<PayrollSheet[]> {
  const res = await c.request<{ rows: PayrollSheet[] }>(
    `/api/payroll/period/${encodeURIComponent(month)}`,
  );
  return res.rows ?? [];
}

/** One employee + month. 404 → null so the caller can show a "no member" state. */
export async function getEmployeePayroll(
  c: ApiClient,
  userId: string,
  month: string,
): Promise<PayrollSheet | null> {
  try {
    const res = await c.request<{ sheet: PayrollSheet }>(
      `/api/payroll/employee/${encodeURIComponent(userId)}/${encodeURIComponent(month)}`,
    );
    return res.sheet;
  } catch (e) {
    // Map 404 → null; re-throw everything else.
    const err = e as { status?: number };
    if (err?.status === 404) return null;
    throw e;
  }
}

export async function calculatePayroll(
  c: ApiClient,
  args: { employeeId: string; month: string },
): Promise<PayrollSheet> {
  const res = await c.request<{ sheet: PayrollSheet }>("/api/payroll/calculate", {
    method: "POST",
    body: args,
  });
  return res.sheet;
}

/** Exposed for AI confirmation paths. Mobile UI does NOT call this in V1. */
export async function finalizePayroll(
  c: ApiClient,
  args: { employeeId: string; month: string },
): Promise<PayrollSheet> {
  const res = await c.request<{ sheet: PayrollSheet }>("/api/payroll/finalize", {
    method: "POST",
    body: args,
  });
  return res.sheet;
}

export async function voidPayroll(
  c: ApiClient,
  args: { periodId: string; reason?: string | null },
): Promise<{ ok: true; id: string }> {
  return c.request<{ ok: true; id: string }>("/api/payroll/void", {
    method: "POST",
    body: args,
  });
}

export async function listAdjustments(
  c: ApiClient,
  args: { employeeId: string; month: string },
): Promise<PayrollAdjustmentRow[]> {
  const res = await c.request<{ rows: PayrollAdjustmentRow[] }>(
    `/api/payroll/adjustments?employeeId=${encodeURIComponent(
      args.employeeId,
    )}&month=${encodeURIComponent(args.month)}`,
  );
  return res.rows ?? [];
}

export async function createAdjustment(
  c: ApiClient,
  args: {
    employeeId: string;
    month: string;
    kind: "bonus" | "deduction" | "advance_repayment" | "correction";
    amount: number;
    reason?: string | null;
  },
): Promise<PayrollAdjustmentRow> {
  const res = await c.request<{ row: PayrollAdjustmentRow }>("/api/payroll/adjustments", {
    method: "POST",
    body: args,
  });
  return res.row;
}

export async function voidAdjustment(
  c: ApiClient,
  id: string,
): Promise<{ ok: true; id: string }> {
  return c.request<{ ok: true; id: string }>(`/api/payroll/adjustments/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function payrollPdfUrl(args: {
  month: string;
  employeeId?: string;
  locale?: "en" | "ar";
}): string {
  const params = new URLSearchParams({ month: args.month });
  if (args.employeeId) params.set("employeeId", args.employeeId);
  if (args.locale) params.set("locale", args.locale);
  return `/api/payroll/pdf?${params.toString()}`;
}
