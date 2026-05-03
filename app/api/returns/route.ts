import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { listReturns, recordReturn } from "@/lib/repo/operations";

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const data = await listReturns(r.ctx.tenantId);
  return NextResponse.json({ data });
}

const schema = z.object({
  saleId: z.string().uuid(),
  productId: z.string().uuid(),
  returnedQuantity: z.number().int().min(1),
  reason: z.string().max(500),
});

export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  try {
    const result = await recordReturn(r.ctx.tenantId, parsed.data);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "خطأ" },
      { status: 400 },
    );
  }
}
