import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { addAttributeValue } from "@/lib/repo/catalog-admin";

const schema = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_-]+$/),
  label: z.string().min(1).max(80),
  position: z.number().int().min(0).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const result = await addAttributeValue(r.ctx.tenantId, r.ctx.branchId, id, parsed.data);
  return NextResponse.json(result, { status: 201 });
}
