import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { deleteProduct, updateProduct } from "@/lib/repo/catalog";
import { logActivity } from "@/lib/repo/activity";

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  brand: z.string().max(80).nullable().optional(),
  quantity: z.number().int().min(0).optional(),
  price: z.number().min(0).optional(),
  costPrice: z.number().min(0).nullable().optional(),
  lowStockThreshold: z.number().int().min(0).optional(),
  sku: z.string().max(80).nullable().optional(),
  tags: z.array(z.string().max(40)).optional(),
  supplier: z.string().max(120).nullable().optional(),
  supplierId: z.string().uuid().nullable().optional(),
  location: z.string().max(120).nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  await updateProduct(r.ctx.tenantId, id, parsed.data);
  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "product.update",
    category: "product",
    entityType: "product",
    entityId: id,
    entityLabel: parsed.data.name ?? null,
    metadata: { changed: Object.keys(parsed.data) },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;
  await deleteProduct(r.ctx.tenantId, id);
  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "product.delete",
    category: "product",
    entityType: "product",
    entityId: id,
  });
  return NextResponse.json({ ok: true });
}
