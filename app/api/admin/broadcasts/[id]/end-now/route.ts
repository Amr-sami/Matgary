import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import { BroadcastError, endBroadcastEarly } from "@/lib/admin/broadcasts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clientIp(req: NextRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip");
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("broadcast.manage");
  if (!r.ok) return r.response;
  const { id } = await params;
  try {
    await endBroadcastEarly(r.session.adminId, id, {
      ip: clientIp(req),
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
