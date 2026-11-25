// GET /api/payroll/employee/[userId]/[month] — one employee's payroll sheet
// for one month. Returns MISSING with a live snapshot when nothing is
// stored yet, so the mobile UI can render the "no draft yet" state without
// a second roundtrip.
//
// Permission: `manage_payroll`. We deliberately do NOT let an employee see
// their OWN sheet via this route — V1 is Owner-facing only; a dedicated
// "self-service payslip" endpoint is a future feature.

import { NextRequest, NextResponse } from "next/server";

import { requirePermission } from "@/lib/api/auth-helpers";
import { getEmployeePayrollMonth } from "@/lib/repo/payroll-periods";
import { parseMonthParam } from "../../../_shared";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string; month: string }> },
) {
  const r = await requirePermission("manage_payroll");
  if (!r.ok) return r.response;
  const { userId, month } = await params;
  const periodStart = parseMonthParam(month);
  if (!periodStart) {
    return NextResponse.json({ error: "invalid_month" }, { status: 400 });
  }
  const sheet = await getEmployeePayrollMonth(r.ctx.tenantId, userId, periodStart);
  if (!sheet) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ sheet });
}
