import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, tenantMembers } from "@/lib/db/schema";
import { requirePermission } from "@/lib/api/auth-helpers";

// Owner-only diagnostic: given a login email + password, tell the owner
// EXACTLY what would happen if the employee tried to log in. Distinguishes
// "user not found" from "wrong password" so the owner can debug without
// guessing. Restricted to the owner's own tenant — can't probe other stores.
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

  if (!user || !user.passwordHash) {
    return NextResponse.json({
      ok: false,
      reason: "user_not_found",
      message: `لا يوجد مستخدم بهذا الاسم: ${email}`,
    });
  }

  // Confirm the owner is testing a member of their own tenant — defense in
  // depth so this endpoint can't be used as a credential oracle for other tenants.
  const [member] = await db
    .select({ tenantId: tenantMembers.tenantId, role: tenantMembers.role })
    .from(tenantMembers)
    .where(eq(tenantMembers.userId, user.id))
    .limit(1);

  if (!member || member.tenantId !== r.ctx.tenantId) {
    return NextResponse.json(
      { ok: false, reason: "not_in_your_tenant", message: "هذا الموظف ليس في متجرك" },
      { status: 403 },
    );
  }

  const passwordOk = await bcrypt.compare(password, user.passwordHash);
  if (!passwordOk) {
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
