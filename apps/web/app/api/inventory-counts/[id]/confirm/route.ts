// POST /api/inventory-counts/[id]/confirm
//   Header (required): Idempotency-Key — a replayed POST with the same key
//                      returns the previously-persisted result instead of
//                      applying adjustments twice.
//   Returns: { countId, confirmedAt, appliedAdjustments, reconciliations }
//
// Reconciliation math per line (see lib/repo/inventory-counts.ts for details):
//   movement_after_count = SUM(product_history.delta WHERE created_at > counted_at)
//   expected_physical    = counted_qty + movement_after_count
//   adjustment           = expected_physical - current_qty_at_confirm
//   final products.quantity = expected_physical
//
// 409 COUNT_HAS_INVALID_LINES → the client must open the resolve-exceptions
// screen and DELETE the offending lines before retrying.

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth-helpers";
import { logActivity } from "@/lib/repo/activity";
import {
  confirmCount,
  InventoryCountConflictError,
} from "@/lib/repo/inventory-counts";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("manage_inventory_counts");
  if (!r.ok) return r.response;
  const { id } = await params;

  const idempotencyKey = req.headers.get("idempotency-key") || `count-${id}-confirm`;

  try {
    const result = await confirmCount(r.ctx.tenantId, id, {
      confirmedByUserId: r.ctx.userId,
      idempotencyKey,
    });

    const shortage = result.reconciliations.filter((x) => x.adjustment < 0).length;
    const overage = result.reconciliations.filter((x) => x.adjustment > 0).length;
    const matched = result.reconciliations.length - shortage - overage;

    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "inventory_count.confirm",
      category: "product",
      entityType: "inventory_count",
      entityId: result.countId,
      metadata: {
        totalLines: result.reconciliations.length,
        appliedAdjustments: result.appliedAdjustments,
        matched,
        shortage,
        overage,
        netAdjustment: result.reconciliations.reduce((a, b) => a + b.adjustment, 0),
      },
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof InventoryCountConflictError) {
      const status =
        err.code === "COUNT_NOT_FOUND" ? 404 : err.code === "ALREADY_CONFIRMED" ? 409 : 409;
      return NextResponse.json(
        { error: err.code, ...(err.details ? { details: err.details } : {}) },
        { status },
      );
    }
    throw err;
  }
}
