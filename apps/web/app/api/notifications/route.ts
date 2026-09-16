import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import {
  listNotificationsForUser,
  unreadNotificationCount,
} from "@/lib/repo/notifications";

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const [items, unread] = await Promise.all([
    listNotificationsForUser(r.ctx.tenantId, r.ctx.userId, 30),
    unreadNotificationCount(r.ctx.tenantId, r.ctx.userId),
  ]);
  return NextResponse.json({ data: items, unread });
}
