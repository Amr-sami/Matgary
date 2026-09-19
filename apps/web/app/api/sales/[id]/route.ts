import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermissionAudited, requireTenant } from "@/lib/api/auth-helpers";
import { getSaleById, updateSale, voidSale } from "@/lib/repo/operations";

// C20 — an id that cannot exist (not a uuid) and one that does not exist both
// answer 404 NOT_FOUND. Without the uuid gate Postgres refuses the `id = $2`
// cast and the route 500s (PATCH even echoed the failed SQL back as a 400);
// without the lookup, updateSale/voidSale throw a plain Error for a missing
// row, which surfaced as 400/500.
const idSchema = z.string().uuid();
const notFound = () => NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return notFound();
  const sale = await getSaleById(r.ctx.tenantId, id);
  if (!sale) return notFound();
  return NextResponse.json({ data: sale });
}

const patchSchema = z.object({
  quantitySold: z.number().int().min(1).optional(),
  pricePerUnit: z.number().min(0).optional(),
  discountType: z.enum(["percentage", "fixed"]).nullable().optional(),
  discountValue: z.number().min(0).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  saleDate: z.string().datetime().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Editing / voiding an existing sale is `modify_sales` (doc 14 §3.1 C5),
  // the permission the web sales page checks before showing these actions.
  const r = await requirePermissionAudited("modify_sales");
  if (!r.ok) return r.response;
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return notFound();
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  if (!(await getSaleById(r.ctx.tenantId, id))) return notFound();
  // No try/catch: the only Error updateSale throws itself is "sale missing",
  // pre-empted above. A DB failure is a real 500 — the old catch turned it
  // into a 400 carrying the raw query text.
  await updateSale(r.ctx.tenantId, id, {
    ...parsed.data,
    saleDate: parsed.data.saleDate ? new Date(parsed.data.saleDate) : undefined,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermissionAudited("modify_sales");
  if (!r.ok) return r.response;
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return notFound();
  if (!(await getSaleById(r.ctx.tenantId, id))) return notFound();
  await voidSale(r.ctx.tenantId, id);
  return NextResponse.json({ ok: true });
}
