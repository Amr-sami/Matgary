// GET /api/payroll/period/[month] — payroll register for one month across
// every tenant member. Gated by `manage_payroll`.
//
// The response is `{ month, rows: PayrollSheetView[] }` — the same shape the
// web register page and the AI's `list_payroll_sheet` tool consume.

import { NextRequest, NextResponse } from "next/server";

import { requirePermission } from "@/lib/api/auth-helpers";
import { listPayrollMonth } from "@/lib/repo/payroll-periods";
import { parseMonthParam } from "../../_shared";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ month: string }> },
) {
  const r = await requirePermission("manage_payroll");
  if (!r.ok) return r.response;
  const { month } = await params;
  const periodStart = parseMonthParam(month);
  if (!periodStart) {
    return NextResponse.json({ error: "invalid_month" }, { status: 400 });
  }
  const rows = await listPayrollMonth(r.ctx.tenantId, periodStart);
  return NextResponse.json({ month, rows });
}
