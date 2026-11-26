// POST /api/inventory-counts/[id]/cancel — abandon a draft/in_progress/review
// count. Idempotent: a second call on an already-cancelled row is a no-op.

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth-helpers";
import { logActivity } from "@/lib/repo/activity";
import {
  cancelCount,
  InventoryCountConflictError,
} from "@/lib/repo/inventory-counts";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("manage_inventory_counts");
  if (!r.ok) return r.response;
  const { id } = await params;

  try {
    await cancelCount(r.ctx.tenantId, id, r.ctx.userId);
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "inventory_count.cancel",
      category: "product",
      entityType: "inventory_count",
      entityId: id,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof InventoryCountConflictError) {
      return NextResponse.json(
        { error: err.code, ...(err.details ? { details: err.details } : {}) },
        { status: err.code === "COUNT_NOT_FOUND" ? 404 : 409 },
      );
    }
    throw err;
  }
}
