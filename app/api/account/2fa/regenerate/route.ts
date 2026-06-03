import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { regenerateRecoveryCodes } from "@/lib/repo/account-security";
import { logActivity } from "@/lib/repo/activity";

const schema = z.object({
  password: z.string().min(1).max(128),
  code: z.string().min(6).max(8),
});

// POST /api/account/2fa/regenerate — same auth as disable; replaces the
// stored hash array with a fresh batch + returns the plaintext codes once.
export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }
  try {
    const recoveryCodes = await regenerateRecoveryCodes(
      r.ctx.userId,
      parsed.data.password,
      parsed.data.code,
    );
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "auth.recovery_codes_regenerated",
      category: "auth",
      entityType: "user",
      entityId: r.ctx.userId,
    });
    return NextResponse.json({ recoveryCodes });
  } catch (err) {
    const code = err instanceof Error ? err.message : "UNKNOWN";
    const known = ["NOT_ENROLLED", "BAD_PASSWORD", "INVALID_TOTP"];
    if (known.includes(code)) {
      return NextResponse.json({ error: code }, { status: 400 });
    }
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
