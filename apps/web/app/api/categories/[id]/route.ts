import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermissionAudited } from "@/lib/api/auth-helpers";
import { CatalogConflictError, deleteCategory, updateCategory } from "@/lib/repo/catalog-admin";

const patchSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  icon: z.string().max(40).nullable().optional(),
  position: z.number().int().min(0).optional(),
  hasAttributes: z.boolean().optional(),
});

// C20 class — a non-uuid id made Postgres refuse the cast (500) and an unknown
// uuid was a silent 200 {ok:true}. The mutators report whether a row matched.
const idSchema = z.string().uuid();
const notFound = () => NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermissionAudited("manage_catalog");
  if (!r.ok) return r.response;
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return notFound();
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  if (!(await updateCategory(r.ctx.tenantId, id, parsed.data))) return notFound();
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermissionAudited("manage_catalog");
  if (!r.ok) return r.response;
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return notFound();
  try {
    if (!(await deleteCategory(r.ctx.tenantId, id))) return notFound();
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof CatalogConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
