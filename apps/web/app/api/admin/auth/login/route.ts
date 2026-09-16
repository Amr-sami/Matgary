import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { admins } from "@/lib/db/schema";
import { getAdminDb } from "@/lib/admin/db";
import { comparePassword } from "@/lib/admin/auth";
import {
  ADMIN_SESSION_COOKIE,
  SESSION_ABS_TTL_MS,
  createSession,
} from "@/lib/admin/session";
import { gateLoginAttempt } from "@/lib/admin/rate-limit";
import { logAuditEvent } from "@/lib/admin/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

// Identical generic response for "no such email" and "wrong password". Never
// leak which is which — that would let an attacker enumerate admins.
const GENERIC_DENIED = { error: "INVALID_CREDENTIALS" } as const;

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent") ?? null;

  // Rate-limit gate FIRST so a credential-stuffer can't time-amplify.
  const gate = await gateLoginAttempt(ip);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "RATE_LIMITED" },
      {
        status: 429,
        headers: gate.retryAfterMs
          ? {
              "Retry-After": String(
                Math.max(1, Math.ceil((gate.retryAfterMs - Date.now()) / 1000)),
              ),
            }
          : undefined,
      },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(GENERIC_DENIED, { status: 401 });
  }
  const { email, password } = parsed.data;
  const db = getAdminDb();

  const rows = await db
    .select({
      id: admins.id,
      email: admins.email,
      passwordHash: admins.passwordHash,
      disabledAt: admins.disabledAt,
      lockedUntil: admins.lockedUntil,
      failedAttempts: admins.failedAttempts,
      mustRotate: admins.mustRotate,
    })
    .from(admins)
    .where(eq(admins.email, email.toLowerCase()))
    .limit(1);
  const admin = rows[0];
  if (!admin) {
    // Treat as a failed attempt for rate-limit fairness — but no DB row
    // to update. Generic response.
    return NextResponse.json(GENERIC_DENIED, { status: 401 });
  }

  if (admin.disabledAt) {
    await logAuditEvent({
      adminId: admin.id,
      action: "auth.login.disabled_admin_attempt",
      ip,
      userAgent: ua,
    });
    return NextResponse.json(GENERIC_DENIED, { status: 401 });
  }

  if (admin.lockedUntil && admin.lockedUntil > new Date()) {
    return NextResponse.json(
      { error: "LOCKED" },
      {
        status: 429,
        headers: {
          "Retry-After": String(
            Math.max(
              1,
              Math.ceil((admin.lockedUntil.getTime() - Date.now()) / 1000),
            ),
          ),
        },
      },
    );
  }

  const matches = await comparePassword(password, admin.passwordHash);
  if (!matches) {
    await db
      .update(admins)
      .set({ failedAttempts: (admin.failedAttempts ?? 0) + 1 })
      .where(eq(admins.id, admin.id));
    return NextResponse.json(GENERIC_DENIED, { status: 401 });
  }

  // Successful login. Reset counters, stamp last_login_*, create the session.
  await db
    .update(admins)
    .set({
      failedAttempts: 0,
      lockedUntil: null,
      lastLoginAt: sql`now()`,
      lastLoginIp: ip,
    })
    .where(eq(admins.id, admin.id));

  const session = await createSession({
    adminId: admin.id,
    ip,
    userAgent: ua,
  });

  await logAuditEvent({
    adminId: admin.id,
    action: "auth.login",
    ip,
    userAgent: ua,
  });

  const res = NextResponse.json({
    ok: true,
    mustRotate: admin.mustRotate,
    redirectTo: admin.mustRotate ? "/admin/account/password?required=1" : "/admin",
  });
  res.cookies.set(ADMIN_SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: Math.floor(SESSION_ABS_TTL_MS / 1000),
  });
  return res;
}
