import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { can } from "@/lib/permissions";
import {
  CashShiftConflictError,
  getShift,
  listMovements,
  recordMovement,
  type CashMovementKind,
} from "@/lib/repo/cash-shifts";
import { logActivity } from "@/lib/repo/activity";

const movementSchema = z.object({
  kind: z.enum(["cash_in", "cash_out", "paid_in", "paid_out"]),
  amount: z.union([z.number(), z.string()]),
  reason: z.string().min(1).max(500),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;
  const shift = await getShift(r.ctx.tenantId, id);
  if (!shift) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const isManager = can(r.ctx, "manage_cash_reconciliation");
  if (!isManager && shift.cashierUserId !== r.ctx.userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const data = await listMovements(r.ctx.tenantId, id);
  return NextResponse.json({ data });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;

  const shift = await getShift(r.ctx.tenantId, id);
  if (!shift) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const isManager = can(r.ctx, "manage_cash_reconciliation");
  if (
    !isManager &&
    shift.cashierUserId !== r.ctx.userId &&
    !can(r.ctx, "open_close_shift")
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = movementSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }
  try {
    const movement = await recordMovement(r.ctx.tenantId, {
      shiftId: id,
      kind: parsed.data.kind as CashMovementKind,
      amount: String(parsed.data.amount),
      reason: parsed.data.reason,
      recordedByUserId: r.ctx.userId,
    });
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "cash_shift.movement",
      category: "settings",
      entityType: "cash_shift",
      entityId: id,
      branchId: shift.branchId,
      metadata: {
        kind: movement.kind,
        amount: movement.amount,
        reason: movement.reason,
      },
    });
    return NextResponse.json({ movement }, { status: 201 });
  } catch (err) {
    if (err instanceof CashShiftConflictError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 409 },
      );
    }
    throw err;
  }
}
