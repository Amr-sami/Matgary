import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth-helpers";
import { computePeriodGross } from "@/lib/repo/payroll";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ employeeId: string }> },
) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const { employeeId } = await params;
  const url = new URL(req.url);
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  const periodStart = fromStr ? new Date(fromStr) : startOfMonth(new Date());
  const periodEnd = toStr ? new Date(toStr) : endOfMonth(new Date());

  const gross = await computePeriodGross(
    r.ctx.tenantId,
    employeeId,
    periodStart,
    periodEnd,
  );
  return NextResponse.json({ gross });
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}
function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
