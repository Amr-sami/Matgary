import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import {
  ImpersonationError,
  prepareImpersonation,
} from "@/lib/admin/impersonation";
import { logAuditEvent } from "@/lib/admin/audit";
import { clientIpOrNull } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("tenant.impersonate");
  if (!r.ok) return r.response;
  const { id } = await params;
  try {
    const ctx = await prepareImpersonation({
      adminId: r.session.adminId,
      adminEmail: r.session.adminEmail,
      tenantId: id,
    });

    await logAuditEvent({
      adminId: r.session.adminId,
      action: "impersonate.start",
      targetKind: "tenant",
      targetId: id,
      ip: clientIpOrNull(req),
      userAgent: req.headers.get("user-agent"),
      before: null,
      after: {
        ownerUserId: ctx.ownerUserId,
        startedAt: new Date(ctx.startedAt).toISOString(),
        expiresAt: new Date(ctx.expiresAt).toISOString(),
        ttlSec: Math.round((ctx.expiresAt - ctx.startedAt) / 1000),
      },
    });

    // The redirect target hits NextAuth's credentials sign-in flow with the
    // one-time token; the client should navigate there as a hard load so
    // the cookie set in the response is picked up before any tenant page
    // renders.
    return NextResponse.json({
      redirectTo: `/api/admin/impersonation/start?token=${encodeURIComponent(ctx.token)}`,
    });
  } catch (err) {
    if (err instanceof ImpersonationError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }
}
