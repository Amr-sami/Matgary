import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  deleteSupplier,
  getSupplier,
  SupplierConflictError,
  updateSupplier,
} from "@/lib/repo/suppliers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("view_suppliers");
  if (!r.ok) return r.response;
  const { id } = await params;
  const data = await getSupplier(r.ctx.tenantId, id);
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ data });
}

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().email().max(120).nullable().optional().or(z.literal("")),
  address: z.string().max(255).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("manage_suppliers");
  if (!r.ok) return r.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const patch = { ...parsed.data };
  if (patch.email === "") patch.email = null;
  await updateSupplier(r.ctx.tenantId, id, patch);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("manage_suppliers");
  if (!r.ok) return r.response;
  const { id } = await params;
  try {
    await deleteSupplier(r.ctx.tenantId, id);
  } catch (err) {
    if (err instanceof SupplierConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
}
