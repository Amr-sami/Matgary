import { NextRequest, NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { markNotificationRead } from "@/lib/repo/notifications";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;
  await markNotificationRead(r.ctx.tenantId, r.ctx.userId, id);
  return NextResponse.json({ ok: true });
}
