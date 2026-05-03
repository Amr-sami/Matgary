import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { addProduct, listProducts } from "@/lib/repo/catalog";

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const data = await listProducts(r.ctx.tenantId);
  return NextResponse.json({ data });
}

const createSchema = z.object({
  name: z.string().min(1).max(200),
  categoryId: z.string().uuid(),
  brand: z.string().max(80).optional(),
  quantity: z.number().int().min(0),
  price: z.number().min(0),
  costPrice: z.number().min(0).optional(),
  lowStockThreshold: z.number().int().min(0).default(3),
  sku: z.string().max(80).optional(),
  tags: z.array(z.string().max(40)).optional(),
  supplier: z.string().max(120).optional(),
  location: z.string().max(120).optional(),
  attributeValueIds: z.array(z.string().uuid()).optional(),
});

export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const { id } = await addProduct(r.ctx.tenantId, parsed.data);
  return NextResponse.json({ id }, { status: 201 });
}
