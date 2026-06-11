// Tenant-side exit point. POST'd from the ImpersonationBanner. Reads the
// current session (which IS the impersonation session — the admin is "in"
// the tenant), writes an audit row, drops the NextAuth cookie, and
// redirects the admin back to the tenant detail page.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  endImpersonationSession,
  getImpersonationSession,
} from "@/lib/admin/impersonation";
import { logAuditEvent } from "@/lib/admin/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clientIp(req: NextRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip");
}

export async function POST(req: NextRequest) {
  const session = await auth().catch(() => null);
  if (!session || !session.impersonation) {
    return NextResponse.json({ error: "NOT_IMPERSONATING" }, { status: 400 });
  }
  const { adminId, sessionId } = session.impersonation;
  const ctx = await getImpersonationSession(sessionId);
  const tenantId = ctx?.tenantId ?? null;

  await endImpersonationSession(sessionId);

  await logAuditEvent({
    adminId,
    action: "impersonate.end",
    targetKind: "tenant",
    targetId: tenantId,
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent"),
    before: {
      sessionId,
      startedAt: new Date(session.impersonation.startedAt).toISOString(),
    },
    after: {
      endedAt: new Date().toISOString(),
      endReason: "admin_exit",
    },
  });

  // Drop every NextAuth session cookie so the next request from this
  // browser is anonymous on the tenant origin. We don't know exactly which
  // names the deployment is configured with (authjs.* default), so clear
  // both the secure-prefixed and bare versions.
  const res = NextResponse.json({
    ok: true,
    redirectTo: tenantId
      ? `/admin/tenants/${tenantId}`
      : "/admin/tenants",
  });
  for (const name of [
    "authjs.session-token",
    "__Secure-authjs.session-token",
    "next-auth.session-token",
    "__Secure-next-auth.session-token",
  ]) {
    res.cookies.set(name, "", { maxAge: 0, path: "/" });
  }
  return res;
}
