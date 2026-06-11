import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { admins } from "@/lib/db/schema";
import { getAdminDb } from "@/lib/admin/db";
import {
  appendPasswordHistory,
  comparePassword,
  hashPassword,
  isPasswordReused,
  validatePasswordShape,
} from "@/lib/admin/auth";
import { revokeAllSessionsForAdmin, ADMIN_SESSION_COOKIE, createSession } from "@/lib/admin/session";
import { requireAdmin } from "@/lib/admin/permissions";
import { logAuditEvent } from "@/lib/admin/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

export async function POST(req: NextRequest) {
  const r = await requireAdmin();
  if (!r.ok) return r.response;
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent") ?? null;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID" }, { status: 400 });
  }
  const { currentPassword, newPassword } = parsed.data;

  const shapeError = validatePasswordShape(newPassword);
  if (shapeError) {
    return NextResponse.json({ error: shapeError }, { status: 400 });
  }

  const db = getAdminDb();
  const [me] = await db
    .select({ id: admins.id, passwordHash: admins.passwordHash })
    .from(admins)
    .where(eq(admins.id, r.session.adminId))
    .limit(1);
  if (!me) {
    return NextResponse.json({ error: "INVALID" }, { status: 400 });
  }

  const currentMatches = await comparePassword(currentPassword, me.passwordHash);
  if (!currentMatches) {
    return NextResponse.json({ error: "WRONG_CURRENT" }, { status: 400 });
  }

  if (await isPasswordReused(me.id, newPassword)) {
    return NextResponse.json({ error: "PASSWORD_REUSED" }, { status: 400 });
  }

  const newHash = await hashPassword(newPassword);

  await db
    .update(admins)
    .set({ passwordHash: newHash, mustRotate: false, updatedAt: new Date() })
    .where(eq(admins.id, me.id));
  await appendPasswordHistory(me.id, newHash);

  // Revoke every other session (defense in depth — if the old password was
  // already compromised, the attacker's parallel session dies here too).
  await revokeAllSessionsForAdmin(me.id);

  // Issue a fresh session for the rotator so they aren't kicked back to /login.
  const session = await createSession({
    adminId: me.id,
    ip,
    userAgent: ua,
  });

  await logAuditEvent({
    adminId: me.id,
    action: "auth.rotate_password",
    ip,
    userAgent: ua,
  });

  const res = NextResponse.json({ ok: true, redirectTo: "/admin" });
  res.cookies.set(ADMIN_SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  return res;
}
