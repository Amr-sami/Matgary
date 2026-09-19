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

// C20 — a non-uuid id made Postgres refuse the `id = $2` cast → 500. It is
// answered 404 NOT_FOUND like an unknown uuid; the client sees one contract.
const idSchema = z.string().uuid();
const notFound = () => NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return notFound();
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }
  const patch = {
    type: parsed.data.type,
    occurredAt: parsed.data.occurredAt
      ? new Date(parsed.data.occurredAt)
      : undefined,
    note: parsed.data.note ?? undefined,
    requiresReview: parsed.data.requiresReview,
  };
  // drizzle throws "No values to set" on an empty .set({}) — that was a 500
  // for `{}` regardless of whether the id existed.
  if (Object.values(patch).every((v) => v === undefined)) {
    return NextResponse.json({ error: "EMPTY_PATCH" }, { status: 400 });
  }
  const event = await updateAttendanceEvent(r.ctx.tenantId, id, patch);
  if (!event) return notFound();
  return NextResponse.json({ event });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return notFound();
  // Idempotent: deleting a uuid that is already gone stays 200.
  await deleteAttendanceEvent(r.ctx.tenantId, id);
  return NextResponse.json({ ok: true });
}
