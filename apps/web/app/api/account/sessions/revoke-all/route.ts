import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { bumpTokenVersion } from "@/lib/repo/account-security";
import { logActivity } from "@/lib/repo/activity";

// POST /api/account/sessions/revoke-all
// Bumps users.token_version → every JWT issued for this user before the
// call is rejected by the next session callback. The current request's
// session also dies, so the client should redirect to /login.
export async function POST() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  await bumpTokenVersion(r.ctx.userId);
  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "auth.session_revoke_all",
    category: "auth",
    entityType: "user",
    entityId: r.ctx.userId,
  });
  return NextResponse.json({ ok: true });
}
