import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  cancelPurchaseOrder,
  PurchaseOrderConflictError,
} from "@/lib/repo/purchase-orders";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("manage_purchases");
  if (!r.ok) return r.response;
  const { id } = await params;
  try {
    await cancelPurchaseOrder(r.ctx.tenantId, id);
  } catch (err) {
    if (err instanceof PurchaseOrderConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
}
