import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  CashShiftConflictError,
  forceCloseShift,
} from "@/lib/repo/cash-shifts";
import { logActivity } from "@/lib/repo/activity";

const schema = z.object({
  reason: z.string().min(1).max(500),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("manage_cash_reconciliation");
  if (!r.ok) return r.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }
  try {
    const shift = await forceCloseShift(
      r.ctx.tenantId,
      id,
      r.ctx.userId,
      parsed.data.reason,
    );
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "cash_shift.force_close",
      category: "settings",
      entityType: "cash_shift",
      entityId: id,
      branchId: shift.branchId,
      metadata: { reason: parsed.data.reason, expected: shift.expectedCash },
    });
    return NextResponse.json({ shift });
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
