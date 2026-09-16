import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import { resetMemberPassword, TeamConflictError } from "@/lib/repo/team";
import { logActivity } from "@/lib/repo/activity";
import { bustUserContextCache } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";

// Manager flow — looser than self-change but still bounded so a compromised
// owner session can't fan a password rewrite out across the whole team.
const PWD_RESET_LIMIT = 10;
const PWD_RESET_WINDOW_SEC = 60 * 60;

const schema = z.object({ newPassword: z.string().min(8).max(128) });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const { userId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const limit = await rateLimit("pwd.reset", r.ctx.userId, {
    limit: PWD_RESET_LIMIT,
    windowSec: PWD_RESET_WINDOW_SEC,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "محاولات كثيرة. حاول لاحقاً." },
      { status: 429 },
    );
  }
  try {
    await resetMemberPassword(r.ctx.tenantId, userId, parsed.data.newPassword);
    await bustUserContextCache(userId);
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "team.password_reset",
      category: "team",
      entityType: "user",
      entityId: userId,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TeamConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
