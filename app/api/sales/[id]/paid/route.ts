import { NextRequest, NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { markSalePaid } from "@/lib/repo/operations";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;
  await markSalePaid(r.ctx.tenantId, id);
  return NextResponse.json({ ok: true });
}
