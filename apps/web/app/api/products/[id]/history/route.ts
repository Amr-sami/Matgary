import { NextRequest, NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { listProductHistory } from "@/lib/repo/catalog";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;
  const data = await listProductHistory(r.ctx.tenantId, id);
  return NextResponse.json({ data });
}
