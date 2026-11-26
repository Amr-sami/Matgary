import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  deletePurchaseOrder,
  getPurchaseOrder,
  PurchaseOrderConflictError,
  updatePurchaseOrderNotes,
} from "@/lib/repo/purchase-orders";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("view_purchases");
  if (!r.ok) return r.response;
  const { id } = await params;
  const data = await getPurchaseOrder(r.ctx.tenantId, id);
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ data });
}

const patchSchema = z.object({
  notes: z.string().max(2000).nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("manage_purchases");
  if (!r.ok) return r.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  if (parsed.data.notes !== undefined) {
    await updatePurchaseOrderNotes(r.ctx.tenantId, id, parsed.data.notes);
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("manage_purchases");
  if (!r.ok) return r.response;
  const { id } = await params;
  try {
    await deletePurchaseOrder(r.ctx.tenantId, id);
  } catch (err) {
    if (err instanceof PurchaseOrderConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
}
