import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { changeOwnPassword, TeamConflictError } from "@/lib/repo/team";
import { logActivity } from "@/lib/repo/activity";
import { bustUserContextCache } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";

// 5 password changes / hour / user. Tight because this endpoint takes a
// plaintext current password and bcrypt-compares — perfect target for
// session-hijack credential reuse and CPU-burn denial.
const PWD_CHANGE_LIMIT = 5;
const PWD_CHANGE_WINDOW_SEC = 60 * 60;

const schema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const limit = await rateLimit("pwd.change", r.ctx.userId, {
    limit: PWD_CHANGE_LIMIT,
    windowSec: PWD_CHANGE_WINDOW_SEC,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "محاولات كثيرة. حاول لاحقاً." },
      { status: 429 },
    );
  }
  try {
    await changeOwnPassword(
      r.ctx.userId,
      parsed.data.currentPassword,
      parsed.data.newPassword,
    );
    await bustUserContextCache(r.ctx.userId);
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "auth.password_change",
      category: "auth",
      entityType: "user",
      entityId: r.ctx.userId,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TeamConflictError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
