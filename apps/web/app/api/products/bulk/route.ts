import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermissionWithBranch } from "@/lib/api/auth-helpers";
import { bulkDeleteProducts, bulkUpdateProducts } from "@/lib/repo/catalog";

const patchSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
  patch: z
    .object({
      brand: z.string().max(80).nullable().optional(),
      quantity: z.number().int().min(0).optional(),
      price: z.number().min(0).optional(),
      costPrice: z.number().min(0).nullable().optional(),
      lowStockThreshold: z.number().int().min(0).optional(),
      tags: z.array(z.string().max(40)).optional(),
      supplier: z.string().max(120).nullable().optional(),
      location: z.string().max(120).nullable().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, "patch must include at least one field"),
});

export async function PATCH(req: NextRequest) {
  // Same gate as POST /api/products and PATCH /api/products/[id]
  // (manage_inventory), audit mode until PERMISSION_ENFORCE_WRITES=1
  // (doc 14 §3.1 C5).
  const r = await requirePermissionWithBranch("manage_inventory");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  await bulkUpdateProducts(r.ctx.tenantId, parsed.data.ids, parsed.data.patch);
  return NextResponse.json({ ok: true });
}

const deleteSchema = z.object({ ids: z.array(z.string().uuid()).min(1) });

export async function DELETE(req: NextRequest) {
  // Same gate as DELETE /api/products/[id] (doc 14 §3.1 C5).
  const r = await requirePermissionWithBranch("manage_inventory");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  await bulkDeleteProducts(r.ctx.tenantId, parsed.data.ids);
  return NextResponse.json({ ok: true });
}
