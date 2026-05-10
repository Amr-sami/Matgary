import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireTenant,
  requireTenantWithBranch,
} from "@/lib/api/auth-helpers";
import { resolveBranchFilter } from "@/lib/api/branch-context";
import { can } from "@/lib/permissions";
import {
  LeaveConflictError,
  listLeaveRequests,
  submitLeaveRequest,
} from "@/lib/repo/leave-requests";
import { logActivity } from "@/lib/repo/activity";

export async function GET(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const filter = await resolveBranchFilter(
    r.ctx,
    req.nextUrl.searchParams.get("branchId"),
  );
  if (!filter.ok) {
    return NextResponse.json({ error: filter.error }, { status: filter.status });
  }
  const isManager = can(r.ctx, "manage_leave");
  const data = await listLeaveRequests(r.ctx.tenantId, {
    onlyForUserId: isManager ? undefined : r.ctx.userId,
    branchId: filter.branchId,
  });
  return NextResponse.json({ data, branchId: filter.branchId });
}

const createSchema = z.object({
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  reason: z.string().max(500).nullable().optional(),
});

export async function POST(req: NextRequest) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  if (!can(r.ctx, "request_leave")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  try {
    const result = await submitLeaveRequest(
      r.ctx.tenantId,
      r.ctx.branchId,
      r.ctx.userId,
      {
        startDate: new Date(parsed.data.startDate),
        endDate: new Date(parsed.data.endDate),
        reason: parsed.data.reason ?? null,
      },
    );
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "leave.submit",
      category: "leave",
      entityType: "leave_request",
      entityId: (result as { id?: string }).id ?? null,
      branchId: r.ctx.branchId,
      metadata: {
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
      },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof LeaveConflictError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
