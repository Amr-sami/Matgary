import { NextRequest, NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { can } from "@/lib/permissions";
import { computeShiftCashFlow, getShift } from "@/lib/repo/cash-shifts";

// One shift's detail, including the live (or snapshot) cash-flow ladder.
// Permission rule: shift owner can always read their own; otherwise the
// caller needs manage_cash_reconciliation.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;
  const shift = await getShift(r.ctx.tenantId, id);
  if (!shift) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const isManager = can(r.ctx, "manage_cash_reconciliation");
  if (!isManager && shift.cashierUserId !== r.ctx.userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Live recompute while open; once closed, we have the frozen snapshot.
  let cashFlow: Awaited<ReturnType<typeof computeShiftCashFlow>> | null = null;
  if (shift.status === "open") {
    cashFlow = await computeShiftCashFlow(r.ctx.tenantId, shift.id);
  }

  return NextResponse.json({
    shift,
    cashFlow,
    snapshot: shift.totalsSnapshot,
  });
}
