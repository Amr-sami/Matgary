import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import {
  TenantActionError,
  unsuspendTenant,
} from "@/lib/admin/tenant-actions";
import { clientIpOrNull } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("tenant.suspend");
  if (!r.ok) return r.response;

  const { id } = await params;
  try {
    await unsuspendTenant(r.session.adminId, id, {
      ip: clientIpOrNull(req),
      userAgent: req.headers.get("user-agent"),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TenantActionError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }
}
