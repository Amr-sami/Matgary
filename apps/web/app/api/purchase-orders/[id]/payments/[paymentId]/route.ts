import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth-helpers";
import { PurchaseOrderConflictError } from "@/lib/repo/purchase-orders";
import { deletePayment } from "@/lib/repo/purchase-payments";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; paymentId: string }> },
) {
  const r = await requirePermission("manage_purchases");
  if (!r.ok) return r.response;
  const { paymentId } = await params;
  try {
    await deletePayment(r.ctx.tenantId, paymentId);
  } catch (err) {
    if (err instanceof PurchaseOrderConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
}
