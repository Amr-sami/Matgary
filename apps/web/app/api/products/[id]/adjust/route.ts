import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { adjustProductQuantity } from "@/lib/repo/catalog";
import { logActivity } from "@/lib/repo/activity";

const schema = z.object({ delta: z.number().int() });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Stock adjustments are inherently per-branch — every "+1 / -1" lands at
  // the active branch only. Use the active context.
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  try {
    // Multi-store: products belong to a single branch and carry their qty
    // directly. The repo verifies the product matches the active branch.
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
      branchId: r.ctx.branchId,
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
