import { NextRequest, NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { can } from "@/lib/permissions";
import {
  deleteLeaveRequest,
  LeaveConflictError,
} from "@/lib/repo/leave-requests";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;
  const canManage = can(r.ctx, "manage_leave");
  try {
    await deleteLeaveRequest(r.ctx.tenantId, r.ctx.userId, canManage, id);
  } catch (err) {
    if (err instanceof LeaveConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
}
