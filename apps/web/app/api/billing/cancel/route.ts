import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { cancelSubscription } from "@/lib/repo/subscriptions";
import { bustUserContextCache } from "@/lib/auth";
import { logActivity } from "@/lib/repo/activity";

export async function POST() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  if (r.ctx.role !== "owner") {
    return NextResponse.json(
      { error: "العملية متاحة لصاحب المتجر فقط." },
      { status: 403 },
    );
  }
  await cancelSubscription(r.ctx.tenantId);
  await bustUserContextCache(r.ctx.userId);
  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "billing.cancelled",
    category: "settings",
  });
  return NextResponse.json({ ok: true });
}
