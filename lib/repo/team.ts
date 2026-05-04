import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, tenantMembers, tenants } from "@/lib/db/schema";
import type { Permission } from "@/lib/permissions";
import { ALL_PERMISSIONS } from "@/lib/permissions";

export class TeamConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamConflictError";
  }
}

export interface TeamMemberDto {
  userId: string;
  /** Synthetic email used as the login identifier (e.g. "ahmed@elhenawystore"). */
  loginEmail: string;
  /** Username portion to the left of "@" — what the owner typed. */
  username: string;
  displayName: string;
  role: string;
  permissions: Permission[];
  mustChangePassword: boolean;
  joinedAt: Date;
}

/**
 * Build the synthetic login email for a sub-account. Local part is the
 * username, domain is the tenant slug. The slug is URL-safe so it's also a
 * valid email-domain string. We don't claim the address actually receives
 * mail — it's an opaque identifier the cashier types into the login form.
 */
export function buildLoginEmail(username: string, tenantSlug: string): string {
  return `${username.trim().toLowerCase()}@${tenantSlug}`;
}

export function splitLoginEmail(email: string): { username: string; domain: string } {
  const at = email.lastIndexOf("@");
  if (at < 0) return { username: email, domain: "" };
  return { username: email.slice(0, at), domain: email.slice(at + 1) };
}

export async function listTeamMembers(tenantId: string): Promise<TeamMemberDto[]> {
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      mustChangePassword: users.mustChangePassword,
      role: tenantMembers.role,
      permissions: tenantMembers.permissions,
      displayName: tenantMembers.displayName,
      joinedAt: tenantMembers.joinedAt,
    })
    .from(tenantMembers)
    .innerJoin(users, eq(users.id, tenantMembers.userId))
    .where(eq(tenantMembers.tenantId, tenantId));

  return rows.map((r) => {
    const { username } = splitLoginEmail(r.email);
    return {
      userId: r.userId,
      loginEmail: r.email,
      username,
      displayName: r.displayName ?? r.name ?? username,
      role: r.role,
      permissions: r.permissions as Permission[],
      mustChangePassword: r.mustChangePassword,
      joinedAt: r.joinedAt,
    };
  });
}

export interface AddTeamMemberInput {
  username: string;
  displayName: string;
  password: string;
  permissions: Permission[];
}

export async function addTeamMember(
  tenantId: string,
  input: AddTeamMemberInput,
): Promise<{ userId: string; loginEmail: string }> {
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,40}$/.test(username)) {
    throw new TeamConflictError(
      "اسم المستخدم: حروف إنجليزية صغيرة أو أرقام أو . _ - فقط (٢-٤٠ حرف)",
    );
  }

  // Sanitize permissions to known keys only — defense against client tampering.
  const cleanPerms = input.permissions.filter((p) => ALL_PERMISSIONS.includes(p));

  const [tenant] = await db
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new TeamConflictError("المتجر غير موجود");

  const loginEmail = buildLoginEmail(username, tenant.slug);

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, loginEmail))
    .limit(1);
  if (existing) {
    throw new TeamConflictError("اسم المستخدم مستخدم بالفعل في هذا المتجر");
  }

  const passwordHash = await bcrypt.hash(input.password, 12);

  const userId = await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({
        email: loginEmail,
        name: input.displayName.trim(),
        passwordHash,
        mustChangePassword: true,
      })
      .returning({ id: users.id });

    await tx.insert(tenantMembers).values({
      tenantId,
      userId: u.id,
      role: "staff",
      permissions: cleanPerms,
      displayName: input.displayName.trim(),
    });

    return u.id;
  });

  return { userId, loginEmail };
}

export async function updateMemberPermissions(
  tenantId: string,
  userId: string,
  patch: { permissions?: Permission[]; displayName?: string },
): Promise<void> {
  // Refuse to touch the tenant's owner (role-protected).
  const [member] = await db
    .select({ role: tenantMembers.role })
    .from(tenantMembers)
    .where(
      and(
        eq(tenantMembers.tenantId, tenantId),
        eq(tenantMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!member) throw new TeamConflictError("الموظف غير موجود");
  if (member.role === "owner") {
    throw new TeamConflictError("لا يمكن تعديل صلاحيات المالك");
  }

  const cleanPerms = patch.permissions
    ? patch.permissions.filter((p) => ALL_PERMISSIONS.includes(p))
    : undefined;

  const set: Record<string, unknown> = {};
  if (cleanPerms) set.permissions = cleanPerms;
  if (patch.displayName !== undefined) set.displayName = patch.displayName.trim();

  if (Object.keys(set).length === 0) return;

  await db
    .update(tenantMembers)
    .set(set)
    .where(
      and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)),
    );

  if (patch.displayName !== undefined) {
    await db
      .update(users)
      .set({ name: patch.displayName.trim() })
      .where(eq(users.id, userId));
  }
}

export async function removeTeamMember(
  tenantId: string,
  userId: string,
): Promise<void> {
  const [member] = await db
    .select({ role: tenantMembers.role })
    .from(tenantMembers)
    .where(
      and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)),
    )
    .limit(1);
  if (!member) return;
  if (member.role === "owner") {
    throw new TeamConflictError("لا يمكن حذف المالك");
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(tenantMembers)
      .where(
        and(
          eq(tenantMembers.tenantId, tenantId),
          eq(tenantMembers.userId, userId),
        ),
      );
    // Also delete the user — sub-accounts are scoped to one tenant in v1.
    await tx.delete(users).where(eq(users.id, userId));
  });
}

/**
 * Owner-initiated password reset for a sub-account: writes a new hash and
 * forces the employee to set their own on next login.
 */
export async function resetMemberPassword(
  tenantId: string,
  userId: string,
  newPassword: string,
): Promise<void> {
  const [member] = await db
    .select({ role: tenantMembers.role })
    .from(tenantMembers)
    .where(
      and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)),
    )
    .limit(1);
  if (!member) throw new TeamConflictError("الموظف غير موجود");
  if (member.role === "owner") {
    throw new TeamConflictError("لا يمكن إعادة تعيين كلمة سر المالك من هنا");
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db
    .update(users)
    .set({ passwordHash, mustChangePassword: true })
    .where(eq(users.id, userId));
}

/**
 * Owner-initiated rename of the store handle (slug). Updates tenants.slug
 * AND every staff user's email (which is `username@old-slug` → `username@new-slug`)
 * in one transaction. The owner's own real email is left alone.
 */
export async function renameStoreHandle(
  tenantId: string,
  newHandle: string,
): Promise<void> {
  const handle = newHandle.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(handle) || handle.length > 40) {
    throw new TeamConflictError("اسم تسجيل الدخول غير صالح");
  }

  await db.transaction(async (tx) => {
    const [tenant] = await tx
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new TeamConflictError("المتجر غير موجود");
    if (tenant.slug === handle) return; // no-op

    const [clash] = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, handle))
      .limit(1);
    if (clash) throw new TeamConflictError("اسم تسجيل الدخول مستخدم بالفعل");

    // Move every staff email from the old @slug to the new one. Owner accounts
    // keep their real email — skip them by checking role.
    const staff = await tx
      .select({
        userId: tenantMembers.userId,
        role: tenantMembers.role,
        email: users.email,
      })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(eq(tenantMembers.tenantId, tenantId));

    for (const m of staff) {
      if (m.role === "owner") continue;
      const { username } = splitLoginEmail(m.email);
      const newEmail = buildLoginEmail(username, handle);
      await tx
        .update(users)
        .set({ email: newEmail })
        .where(eq(users.id, m.userId));
    }

    await tx.update(tenants).set({ slug: handle }).where(eq(tenants.id, tenantId));
  });
}

/**
 * Self-service password change. Verifies current password, updates hash,
 * clears must_change_password.
 */
export async function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user || !user.passwordHash) {
    throw new TeamConflictError("المستخدم غير موجود");
  }

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw new TeamConflictError("كلمة السر الحالية غير صحيحة");

  const newHash = await bcrypt.hash(newPassword, 12);
  await db
    .update(users)
    .set({ passwordHash: newHash, mustChangePassword: false })
    .where(eq(users.id, userId));
}
