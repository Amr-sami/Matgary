import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth-helpers";
import { deleteStoreLocation } from "@/lib/repo/attendance";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const { id } = await params;
  await deleteStoreLocation(r.ctx.tenantId, id);
  return NextResponse.json({ ok: true });
}
