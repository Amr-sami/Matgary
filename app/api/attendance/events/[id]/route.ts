import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  deleteAttendanceEvent,
  updateAttendanceEvent,
} from "@/lib/repo/attendance-events";

const TYPES = ["check_in", "check_out"] as const;

const patchSchema = z.object({
  type: z.enum(TYPES).optional(),
  occurredAt: z.string().datetime().optional(),
  note: z.string().max(500).nullable().optional(),
  requiresReview: z.boolean().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }
  const event = await updateAttendanceEvent(r.ctx.tenantId, id, {
    type: parsed.data.type,
    occurredAt: parsed.data.occurredAt
      ? new Date(parsed.data.occurredAt)
      : undefined,
    note: parsed.data.note ?? undefined,
    requiresReview: parsed.data.requiresReview,
  });
  if (!event) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ event });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const { id } = await params;
  await deleteAttendanceEvent(r.ctx.tenantId, id);
  return NextResponse.json({ ok: true });
}
