import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { cancelDeletion } from "@/lib/repo/tenant-deletion";
import { logActivity } from "@/lib/repo/activity";

// POST /api/account/delete/cancel — clear any pending deletion for owner's
// tenant. Available to the owner role only.
export async function POST() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  if (r.ctx.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await cancelDeletion(r.ctx.tenantId);
  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "tenant.deletion_cancelled",
    category: "settings",
    entityType: "tenant",
    entityId: r.ctx.tenantId,
  });
  return NextResponse.json({ ok: true });
}
