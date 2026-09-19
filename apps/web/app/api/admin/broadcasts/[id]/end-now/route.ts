import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import { BroadcastError, endBroadcastEarly } from "@/lib/admin/broadcasts";
import { clientIpOrNull } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("broadcast.manage");
  if (!r.ok) return r.response;
  const { id } = await params;
  try {
    await endBroadcastEarly(r.session.adminId, id, {
      ip: clientIpOrNull(req),
      userAgent: req.headers.get("user-agent"),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof BroadcastError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }
}
