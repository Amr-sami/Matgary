import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { adjustProductQuantity } from "@/lib/repo/catalog";
import { logActivity } from "@/lib/repo/activity";

const schema = z.object({ delta: z.number().int() });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  try {
    const newQuantity = await adjustProductQuantity(
      r.ctx.tenantId,
      id,
      parsed.data.delta,
    );
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "product.adjust",
      category: "product",
      entityType: "product",
      entityId: id,
      metadata: { delta: parsed.data.delta, newQuantity },
    });
    return NextResponse.json({ newQuantity });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "خطأ" },
      { status: 404 },
    );
  }
}
