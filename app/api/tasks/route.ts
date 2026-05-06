import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { can } from "@/lib/permissions";
import {
  createTask,
  listTasks,
  TaskConflictError,
} from "@/lib/repo/tasks";

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const isManager = can(r.ctx, "manage_tasks");
  const data = await listTasks(r.ctx.tenantId, {
    onlyForUserId: isManager ? undefined : r.ctx.userId,
  });
  return NextResponse.json({ data });
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  assignedToUserId: z.string().uuid().nullable().optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
  dueDate: z.string().datetime().nullable().optional(),
});

export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  if (!can(r.ctx, "manage_tasks")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  try {
    const result = await createTask(r.ctx.tenantId, r.ctx.userId, {
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      assignedToUserId: parsed.data.assignedToUserId ?? null,
      priority: parsed.data.priority,
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof TaskConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
