import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { markAllTasksSeen } from "@/lib/repo/tasks";

export async function POST() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  await markAllTasksSeen(r.ctx.tenantId, r.ctx.userId);
  return NextResponse.json({ ok: true });
}
