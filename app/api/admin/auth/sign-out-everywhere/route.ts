import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/permissions";
import {
  ADMIN_SESSION_COOKIE,
  revokeAllSessionsForAdmin,
} from "@/lib/admin/session";
import { logAuditEvent } from "@/lib/admin/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const r = await requireAdmin();
  if (!r.ok) return r.response;

  await revokeAllSessionsForAdmin(r.session.adminId);
  await logAuditEvent({
    adminId: r.session.adminId,
    action: "auth.sign_out_everywhere",
  });

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return res;
}
