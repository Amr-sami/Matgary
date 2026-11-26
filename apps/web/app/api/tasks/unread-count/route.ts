import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { unreadTaskCountForUser } from "@/lib/repo/tasks";

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const count = await unreadTaskCountForUser(r.ctx.tenantId, r.ctx.userId);
  return NextResponse.json({ count });
}
