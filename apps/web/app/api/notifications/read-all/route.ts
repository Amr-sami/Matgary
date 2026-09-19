import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { markAllNotificationsRead } from "@/lib/repo/notifications";

export async function POST() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  await markAllNotificationsRead(r.ctx.tenantId, r.ctx.userId);
  return NextResponse.json({ ok: true });
}
