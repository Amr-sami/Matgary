import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import { AdminMgmtError, resetAdminPassword } from "@/lib/admin/admins";
import { clientIpOrNull } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("admin.manage");
  if (!r.ok) return r.response;
  const { id } = await params;
  try {
    const { tempPassword } = await resetAdminPassword(
      r.session.adminId,
      id,
      { ip: clientIpOrNull(req), userAgent: req.headers.get("user-agent") },
    );
    return NextResponse.json({ tempPassword });
  } catch (err) {
    if (err instanceof AdminMgmtError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }
}
