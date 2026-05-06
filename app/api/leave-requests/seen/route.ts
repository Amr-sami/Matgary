import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { markReadByKind } from "@/lib/repo/notifications";

/**
 * Marks every leave-related notification for the current user as read.
 * Manager opening the leave inbox clears their `leave_submitted` badge;
 * employee opening their leave page clears their `leave_decided` badge.
 */
export async function POST() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  await markReadByKind(r.ctx.tenantId, r.ctx.userId, [
    "leave_submitted",
    "leave_decided",
  ]);
  return NextResponse.json({ ok: true });
}
