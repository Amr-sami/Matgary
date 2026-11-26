// DELETE one employee schedule. Owner / manage_team only. Audit-logged.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { employeeSchedules } from "@/lib/db/schema";
import { requireTenant } from "@/lib/api/auth-helpers";
import { insertActivityRow } from "@/lib/repo/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ userId: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const canManage =
    r.ctx.role === "owner" || r.ctx.permissions.includes("manage_team");
  if (!canManage) {
    return NextResponse.json(
      { error: "FORBIDDEN", reason: "manage_team required" },
      { status: 403 },
    );
  }

  const { userId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    return NextResponse.json({ error: "INVALID_USER_ID" }, { status: 400 });
  }

  const [existing] = await withTenant(r.ctx.tenantId, (tx) =>
    tx
      .select()
      .from(employeeSchedules)
      .where(
        and(
          eq(employeeSchedules.tenantId, r.ctx.tenantId),
          eq(employeeSchedules.userId, userId),
        ),
      )
      .limit(1),
  );
  if (!existing) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  await withTenant(r.ctx.tenantId, (tx) =>
    tx
      .delete(employeeSchedules)
      .where(
        and(
          eq(employeeSchedules.tenantId, r.ctx.tenantId),
          eq(employeeSchedules.userId, userId),
        ),
      ),
  );

  await insertActivityRow({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "attendance.schedule.removed",
    category: "attendance",
    entityType: "employee_schedule",
    entityId: userId,
    metadata: {
      before: {
        shiftStart: existing.shiftStart,
        shiftEnd: existing.shiftEnd,
        workDays: existing.workDays,
        graceMinutes: existing.graceMinutes,
        enabled: existing.enabled,
      },
      after: null,
    },
  });

  return NextResponse.json({ ok: true });
}
