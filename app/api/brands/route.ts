import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { listBrands } from "@/lib/repo/catalog";
import { addBrand } from "@/lib/repo/catalog-admin";

export async function GET(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const categoryId = req.nextUrl.searchParams.get("categoryId") || undefined;
  const data = await listBrands(r.ctx.tenantId, categoryId);
  return NextResponse.json({ data });
}

const createSchema = z.object({
  name: z.string().min(1).max(80),
  categoryId: z.string().uuid().nullable().optional(),
});

export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const result = await addBrand(r.ctx.tenantId, {
    name: parsed.data.name,
    categoryId: parsed.data.categoryId ?? null,
  });
  return NextResponse.json(result, { status: 201 });
}
