import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, tenantMembers } from "@/lib/db/schema";
import { requirePermission } from "@/lib/api/auth-helpers";
import { rateLimit } from "@/lib/ratelimit";
import { logActivity } from "@/lib/repo/activity";

// Owner-only diagnostic: given a login email + password, tell the owner
// EXACTLY what would happen if the employee tried to log in — distinguishing
// "no such employee" from "wrong password". Restricted to the owner's own
// tenant: emails registered to other tenants OR not registered at all
// return the same `no_such_employee` reason, so this endpoint cannot be
// used as a platform-wide email-enumeration oracle (F-04).

// F-04 — per-caller rate limit. Without it, a compromised owner session
// becomes an unbounded bcrypt oracle against every staff member of the
// tenant. 10 attempts per hour is plenty for legitimate "did I save the
// password right?" workflows but throttles brute-force to multi-week
// timescales.
const TEST_LOGIN_LIMIT = 10;
const TEST_LOGIN_WINDOW_SEC = 60 * 60;

const schema = z.object({
  email: z.string().min(3).max(200),
  password: z.string().min(1).max(128),
});

function normalize(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[​-‏‪-‮﻿]/g, "") // ZWSP, RLM, LRM, etc.
    .trim()
    .toLowerCase();
}

export async function POST(req: NextRequest) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;

  // F-04 — peek before parse so a malformed body still counts toward the
  // budget (an attacker can't bypass the limit by spamming garbage).
  const rl = await rateLimit("team.test_login", r.ctx.userId, {
    limit: TEST_LOGIN_LIMIT,
    windowSec: TEST_LOGIN_WINDOW_SEC,
  });
  if (!rl.ok) {
    return NextResponse.json(
      {
        ok: false,
        reason: "rate_limited",
        message: "محاولات كثيرة. حاول مرة أخرى بعد قليل.",
      },
      { status: 429 },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const email = normalize(parsed.data.email);
  const password = parsed.data.password; // do NOT trim — passwords can legitimately have trailing/leading spaces

  const [user] = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // F-04 — return ONE response shape for both "email never existed" and
  // "email exists but isn't in your tenant". The previous split
  // (user_not_found vs not_in_your_tenant) leaked platform-wide email
  // existence to logged-in owners. Audit every reject — abuse pattern
  // will show up as bursts in the `auth` activity log.
  const recordReject = (reason: string, targetUserId: string | null) => {
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "team.test_login.reject",
      category: "auth",
      entityType: "user",
      entityId: targetUserId,
      metadata: { reason },
    });
  };

  if (!user || !user.passwordHash) {
    recordReject("no_such_employee", null);
    return NextResponse.json({
      ok: false,
      reason: "no_such_employee",
      message: "لا يوجد موظف بهذا البريد في متجرك",
    });
  }

  // Confirm the owner is testing a member of their own tenant.
  const [member] = await db
    .select({ tenantId: tenantMembers.tenantId, role: tenantMembers.role })
    .from(tenantMembers)
    .where(eq(tenantMembers.userId, user.id))
    .limit(1);

  if (!member || member.tenantId !== r.ctx.tenantId) {
    recordReject("no_such_employee", user.id);
    // Same shape as user-not-found — no platform-wide enumeration leak.
    return NextResponse.json({
      ok: false,
      reason: "no_such_employee",
      message: "لا يوجد موظف بهذا البريد في متجرك",
    });
  }

  const passwordOk = await bcrypt.compare(password, user.passwordHash);
  if (!passwordOk) {
    recordReject("wrong_password", user.id);
    return NextResponse.json({
      ok: false,
      reason: "wrong_password",
      message: "كلمة السر غير صحيحة",
    });
  }

  return NextResponse.json({
    ok: true,
    mustChangePassword: user.mustChangePassword,
    message: user.mustChangePassword
      ? "البيانات صحيحة — سيُطلب من الموظف تغيير كلمة السر عند الدخول"
      : "البيانات صحيحة وجاهزة للاستخدام",
  });
}
