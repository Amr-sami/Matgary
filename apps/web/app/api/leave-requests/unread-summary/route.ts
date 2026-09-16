import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { unreadCountByKind } from "@/lib/repo/notifications";

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const [submitted, decided] = await Promise.all([
    unreadCountByKind(r.ctx.tenantId, r.ctx.userId, ["leave_submitted"]),
    unreadCountByKind(r.ctx.tenantId, r.ctx.userId, ["leave_decided"]),
  ]);
  return NextResponse.json({ submitted, decided });
}
