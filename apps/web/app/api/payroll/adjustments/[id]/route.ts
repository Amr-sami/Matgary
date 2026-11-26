// DELETE /api/payroll/adjustments/[id] — soft-void a live adjustment.
// Refuses if the containing period is already finalized (the repo layer
// enforces this; we surface a 409).

import { NextRequest, NextResponse } from "next/server";

import { requirePermission } from "@/lib/api/auth-helpers";
import { logActivity } from "@/lib/repo/activity";
import {
  PayrollLifecycleError,
  voidPayrollAdjustment,
} from "@/lib/repo/payroll-periods";
import { uuidShape } from "@/lib/finance/uuid-shape";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("manage_payroll");
  if (!r.ok) return r.response;
  const { id } = await params;
  const parsed = uuidShape.safeParse(id);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    const row = await voidPayrollAdjustment(r.ctx.tenantId, parsed.data, r.ctx.userId);
    await logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "payroll.adjustment_void",
      category: "payroll",
      entityType: "payroll_adjustment",
      entityId: row.id,
      metadata: {
        employeeId: row.employeeId,
        periodMonth: row.periodMonth.toISOString(),
        kind: row.kind,
        amount: Number(row.amount),
      },
    });
    return NextResponse.json({ ok: true, id: row.id });
  } catch (e) {
    if (e instanceof PayrollLifecycleError) {
      return NextResponse.json({ error: e.code }, { status: 409 });
    }
    throw e;
  }
}
