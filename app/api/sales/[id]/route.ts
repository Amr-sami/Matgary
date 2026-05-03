import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { getSaleById, updateSale, voidSale } from "@/lib/repo/operations";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;
  const sale = await getSaleById(r.ctx.tenantId, id);
  if (!sale) return NextResponse.json({ error: "Not found" }, { status: 404 });
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
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  try {
    await updateSale(r.ctx.tenantId, id, {
      ...parsed.data,
      saleDate: parsed.data.saleDate ? new Date(parsed.data.saleDate) : undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "خطأ" },
      { status: 400 },
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;
  await voidSale(r.ctx.tenantId, id);
  return NextResponse.json({ ok: true });
}
