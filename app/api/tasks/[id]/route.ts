import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { can } from "@/lib/permissions";
import {
  deleteTask,
  setTaskStatus,
  TaskConflictError,
  updateTask,
  type TaskStatus,
} from "@/lib/repo/tasks";
import { withTenant } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

const patchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    assignedToUserId: z.string().uuid().nullable().optional(),
    priority: z.enum(["low", "normal", "high"]).optional(),
    dueDate: z.string().datetime().nullable().optional(),
    status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
  })
  .strict();

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  // Status changes are allowed by either the assignee or a manager.
  // All other field edits require manage_tasks.
  const isManager = can(r.ctx, "manage_tasks");
  const onlyStatus =
    parsed.data.status !== undefined &&
    Object.keys(parsed.data).length === 1;

  if (!isManager && !onlyStatus) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    if (parsed.data.status !== undefined && !isManager) {
      // Verify the assignee match before allowing the status change.
      const ownsThis = await withTenant(r.ctx.tenantId, async (tx) => {
        const [row] = await tx
          .select({ assignedToUserId: tasks.assignedToUserId })
          .from(tasks)
          .where(and(eq(tasks.tenantId, r.ctx.tenantId), eq(tasks.id, id)))
          .limit(1);
        return row?.assignedToUserId === r.ctx.userId;
      });
      if (!ownsThis) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    if (parsed.data.status !== undefined) {
      await setTaskStatus(
        r.ctx.tenantId,
        id,
        r.ctx.userId,
        parsed.data.status as TaskStatus,
      );
    }
    // Manager-only updates to other fields.
    const { status: _ignore, ...rest } = parsed.data;
    if (isManager && Object.keys(rest).length > 0) {
      await updateTask(r.ctx.tenantId, id, {
        title: rest.title,
        description: rest.description,
        assignedToUserId: rest.assignedToUserId,
        priority: rest.priority,
        dueDate: rest.dueDate ? new Date(rest.dueDate) : rest.dueDate === null ? null : undefined,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TaskConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  if (!can(r.ctx, "manage_tasks")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  await deleteTask(r.ctx.tenantId, id);
  return NextResponse.json({ ok: true });
}
