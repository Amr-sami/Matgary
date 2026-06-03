import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { verifyAndEnable } from "@/lib/repo/account-security";
import { logActivity } from "@/lib/repo/activity";

const schema = z.object({
  secret: z.string().min(16).max(64),
  code: z.string().min(6).max(8),
});

// POST /api/account/2fa/enable — verifies the pasted code against the
// (uncommitted) secret, then commits the secret + generates + stores the
// hashed recovery codes. Returns the plaintext recovery codes ONCE.
export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  if (r.ctx.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }
  try {
    const { recoveryCodes } = await verifyAndEnable(
      r.ctx.userId,
      parsed.data.secret,
      parsed.data.code,
    );
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "auth.2fa_enable",
      category: "auth",
      entityType: "user",
      entityId: r.ctx.userId,
    });
    return NextResponse.json({ recoveryCodes });
  } catch (err) {
    const code = err instanceof Error ? err.message : "UNKNOWN";
    if (code === "INVALID_TOTP") {
      return NextResponse.json({ error: code }, { status: 400 });
    }
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
