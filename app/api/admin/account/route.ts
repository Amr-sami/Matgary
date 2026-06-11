import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { admins } from "@/lib/db/schema";
import { getAdminDb } from "@/lib/admin/db";
import { requireAdmin } from "@/lib/admin/permissions";
import { logAuditEvent } from "@/lib/admin/audit";
import { comparePassword } from "@/lib/admin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await requireAdmin();
  if (!r.ok) return r.response;
  const db = getAdminDb();
  const [me] = await db
    .select({
      id: admins.id,
      email: admins.email,
      displayName: admins.displayName,
      role: admins.role,
      mustRotate: admins.mustRotate,
      lastLoginAt: admins.lastLoginAt,
      createdAt: admins.createdAt,
    })
    .from(admins)
    .where(eq(admins.id, r.session.adminId))
    .limit(1);
  return NextResponse.json({ account: me ?? null });
}

const patchSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  // Changing email re-confirms via current password — the rotation page is
  // the canonical place to change the password itself.
  email: z.string().email().max(200).optional(),
  currentPassword: z.string().min(1).max(200).optional(),
});

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

export async function PATCH(req: NextRequest) {
  const r = await requireAdmin();
  if (!r.ok) return r.response;
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent") ?? null;

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "INVALID" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const [before] = await db
    .select()
    .from(admins)
    .where(eq(admins.id, r.session.adminId))
    .limit(1);
  if (!before) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const set: Record<string, unknown> = {};
  if (parsed.data.displayName !== undefined) {
    set.displayName = parsed.data.displayName;
  }
  if (parsed.data.email !== undefined && parsed.data.email !== before.email) {
    // Email change requires current password re-auth.
    if (!parsed.data.currentPassword) {
      return NextResponse.json({ error: "NEED_PASSWORD" }, { status: 400 });
    }
    const ok = await comparePassword(parsed.data.currentPassword, before.passwordHash);
    if (!ok) {
      return NextResponse.json({ error: "WRONG_CURRENT" }, { status: 400 });
    }
    set.email = parsed.data.email;
  }
  if (Object.keys(set).length === 0) {
    return NextResponse.json({ ok: true, unchanged: true });
  }
  set.updatedAt = new Date();

  await db.update(admins).set(set).where(eq(admins.id, before.id));

  await logAuditEvent({
    adminId: before.id,
    action: "auth.account_update",
    ip,
    userAgent: ua,
    before: {
      email: before.email,
      displayName: before.displayName,
    },
    after: {
      email: set.email ?? before.email,
      displayName: set.displayName ?? before.displayName,
    },
  });

  return NextResponse.json({ ok: true });
}
