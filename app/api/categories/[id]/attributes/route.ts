import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { listAttributesForCategory } from "@/lib/repo/catalog";
import { addAttribute } from "@/lib/repo/catalog-admin";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;
  const data = await listAttributesForCategory(r.ctx.tenantId, id);
  return NextResponse.json({ data });
}

const createSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_-]+$/),
  label: z.string().min(1).max(80),
  position: z.number().int().min(0).optional(),
  required: z.boolean().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const result = await addAttribute(r.ctx.tenantId, {
    categoryId: id,
    ...parsed.data,
  });
  return NextResponse.json(result, { status: 201 });
}
