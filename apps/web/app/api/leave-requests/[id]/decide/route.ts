import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { can } from "@/lib/permissions";
import {
  decideLeaveRequest,
  LeaveConflictError,
} from "@/lib/repo/leave-requests";
import { logActivity } from "@/lib/repo/activity";

const schema = z.object({
  status: z.enum(["approved", "rejected"]),
  note: z.string().max(500).nullable().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  if (!can(r.ctx, "manage_leave")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  try {
    await decideLeaveRequest(
      r.ctx.tenantId,
      r.ctx.userId,
      id,
      parsed.data.status,
      parsed.data.note ?? null,
    );
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: parsed.data.status === "approved" ? "leave.approve" : "leave.reject",
      category: "leave",
      entityType: "leave_request",
      entityId: id,
      metadata: parsed.data.note ? { note: parsed.data.note } : null,
    });
  } catch (err) {
    if (err instanceof LeaveConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
}
