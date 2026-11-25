import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermissionWithBranch } from "@/lib/api/auth-helpers";
import { adjustProductQuantity } from "@/lib/repo/catalog";
import { logActivity } from "@/lib/repo/activity";
import { fanoutEvent } from "@/lib/notifications/dispatch";
import { withTenant } from "@/lib/db";
import { products as productsTable } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

const schema = z.object({ delta: z.number().int() });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Stock adjustments are inherently per-branch — every "+1 / -1" lands at
  // the active branch only. Use the active context. Same gate as POST
  // /api/products: manage_inventory, audit-mode until
  // PERMISSION_ENFORCE_WRITES=1.
  const r = await requirePermissionWithBranch("manage_inventory");
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
    // One cheap read to resolve the product name for the push body.
    const [p] = await withTenant(r.ctx.tenantId, (tx) =>
      tx
        .select({ name: productsTable.name })
        .from(productsTable)
        .where(and(eq(productsTable.tenantId, r.ctx.tenantId), eq(productsTable.id, id)))
        .limit(1),
    );
    void fanoutEvent(r.ctx.tenantId, r.ctx.branchId, "inventory.adjusted", {
      productId: id,
      productName: p?.name ?? "?",
      deltaQty: parsed.data.delta,
      newQty: newQuantity,
      actorUserId: r.ctx.userId,
      link: `/inventory/${id}`,
    });
    return NextResponse.json({ newQuantity });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "خطأ" },
      { status: 404 },
    );
  }
}
