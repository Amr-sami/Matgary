// Admin-user management. Backs /admin/admins. Every mutation goes through
// the BYPASSRLS pool, writes an audit row, and (for role/disable/delete/
// reset-password) revokes the target admin's sessions so changes take
// effect immediately.

import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { adminPasswordHistory, admins } from "@/lib/db/schema";
import { getAdminDb } from "./db";
import { logAuditEvent } from "./audit";
import { appendPasswordHistory, hashPassword } from "./auth";
import { revokeAllSessionsForAdmin } from "./session";

export type AdminRole = "super_admin" | "ops_admin";

export interface AdminListRow {
  id: string;
  email: string;
  displayName: string | null;
  role: AdminRole;
  disabled: boolean;
  mustRotate: boolean;
  lastLoginAt: Date | null;
  lastPasswordChangeAt: Date | null;
  createdAt: Date;
  createdByEmail: string | null;
  isCurrent: boolean;
}

export class AdminMgmtError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const TEMP_PASSWORD_LEN = 16;
// No 0/O/1/l/I — easy to copy + impossible to confuse over WhatsApp.
const TEMP_PASSWORD_ALPHABET =
  "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/** Crypto-strong 16-character temp password. Returned by addAdmin and
 *  resetAdminPassword — shown to the calling admin ONCE; never re-fetchable. */
export function generateTempPassword(): string {
  const bytes = randomBytes(TEMP_PASSWORD_LEN * 2);
  const max = TEMP_PASSWORD_ALPHABET.length;
  let out = "";
  // Reject-sample to keep the distribution uniform across the alphabet
  // (modulo would bias the first few chars).
  const threshold = Math.floor(256 / max) * max;
  for (let i = 0; i < bytes.length && out.length < TEMP_PASSWORD_LEN; i += 1) {
    const b = bytes[i]!;
    if (b < threshold) {
      out += TEMP_PASSWORD_ALPHABET[b % max];
    }
  }
  // Fallback in the vanishingly unlikely case we ran out of bytes.
  while (out.length < TEMP_PASSWORD_LEN) {
    out += TEMP_PASSWORD_ALPHABET[randomBytes(1)[0]! % max];
  }
  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Count the admins that would remain `super_admin AND enabled` AFTER a
 *  hypothetical mutation on `targetAdminId`. Used by every mutation that
 *  could lock the platform out of super-admin coverage. */
async function countSuperAdminsAfter(
  targetAdminId: string,
  becomingRole: AdminRole,
  becomingDisabled: boolean,
): Promise<number> {
  const db = getAdminDb();
  const rows = await db
    .select({
      id: admins.id,
      role: admins.role,
      disabledAt: admins.disabledAt,
    })
    .from(admins);
  let count = 0;
  for (const r of rows) {
    if (r.id === targetAdminId) {
      if (becomingRole === "super_admin" && !becomingDisabled) count += 1;
    } else if (r.role === "super_admin" && !r.disabledAt) {
      count += 1;
    }
  }
  return count;
}

/** Throws LAST_SUPER_ADMIN if the change would leave zero enabled
 *  super-admins. Pass the role + disabled state the target will have AFTER
 *  the mutation. */
async function refuseIfLastSuperAdminCheck(
  targetAdminId: string,
  becomingRole: AdminRole,
  becomingDisabled: boolean,
): Promise<void> {
  const remaining = await countSuperAdminsAfter(
    targetAdminId,
    becomingRole,
    becomingDisabled,
  );
  if (remaining < 1) {
    throw new AdminMgmtError(
      "LAST_SUPER_ADMIN",
      "Cannot remove the last enabled super_admin.",
    );
  }
}

// ─── Reads ───────────────────────────────────────────────────────────────

export async function listAdmins(currentAdminId: string): Promise<AdminListRow[]> {
  const db = getAdminDb();
  // Latest password-change date per admin via a correlated subquery — keeps
  // the API one round-trip.
  const rows = await db.execute(sql`
    select
      a.id,
      a.email,
      a.display_name as "displayName",
      a.role,
      (a.disabled_at is not null) as disabled,
      a.must_rotate as "mustRotate",
      a.last_login_at as "lastLoginAt",
      (
        select max(h.changed_at)
        from admin_password_history h
        where h.admin_id = a.id
      ) as "lastPasswordChangeAt",
      a.created_at as "createdAt",
      (
        select c.email
        from admins c
        where c.id = a.created_by_admin_id
      ) as "createdByEmail"
    from admins a
    order by (a.disabled_at is not null) asc, a.created_at asc
  `);

  const rawArr =
    (Array.isArray(rows)
      ? rows
      : (rows as { rows?: unknown[] }).rows) ?? [];
  const arr = rawArr as AdminListRow[];
  return arr.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    role: r.role as AdminRole,
    disabled: !!r.disabled,
    mustRotate: !!r.mustRotate,
    lastLoginAt: r.lastLoginAt ? new Date(r.lastLoginAt) : null,
    lastPasswordChangeAt: r.lastPasswordChangeAt
      ? new Date(r.lastPasswordChangeAt)
      : null,
    createdAt: new Date(r.createdAt),
    createdByEmail: r.createdByEmail,
    isCurrent: r.id === currentAdminId,
  }));
}

// ─── Writes ──────────────────────────────────────────────────────────────

export interface AddAdminInput {
  email: string;
  displayName: string;
  role: AdminRole;
}

export interface ActionMeta {
  ip: string | null;
  userAgent: string | null;
}

export async function addAdmin(
  callerAdminId: string,
  input: AddAdminInput,
  meta: ActionMeta,
): Promise<{ id: string; tempPassword: string }> {
  if (!input.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    throw new AdminMgmtError("INVALID_EMAIL", "Email is invalid", 400);
  }
  if (!input.displayName.trim() || input.displayName.length > 80) {
    throw new AdminMgmtError("INVALID_NAME", "Display name 1-80 chars", 400);
  }
  if (input.role !== "super_admin" && input.role !== "ops_admin") {
    throw new AdminMgmtError("INVALID_ROLE", "Role must be super_admin or ops_admin", 400);
  }

  const db = getAdminDb();
  // Pre-check email uniqueness — gives a 409 instead of 500.
  const [exists] = await db
    .select({ id: admins.id })
    .from(admins)
    .where(eq(admins.email, input.email.toLowerCase()))
    .limit(1);
  if (exists) {
    throw new AdminMgmtError("EMAIL_TAKEN", "An admin with that email already exists");
  }

  const tempPassword = generateTempPassword();
  const hash = await hashPassword(tempPassword);

  const [created] = await db
    .insert(admins)
    .values({
      email: input.email.toLowerCase(),
      passwordHash: hash,
      displayName: input.displayName.trim(),
      role: input.role,
      mustRotate: true,
      createdByAdminId: callerAdminId,
    })
    .returning({ id: admins.id });

  // Seed history with the temp password's hash so its successor can't reuse it.
  await appendPasswordHistory(created.id, hash);

  await logAuditEvent({
    adminId: callerAdminId,
    action: "admin.add",
    targetKind: "admin",
    targetId: created.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    before: null,
    after: {
      email: input.email.toLowerCase(),
      displayName: input.displayName.trim(),
      role: input.role,
      mustRotate: true,
    },
  });

  return { id: created.id, tempPassword };
}

export interface PatchAdminInput {
  displayName?: string;
  role?: AdminRole;
  disabled?: boolean;
}

export async function patchAdmin(
  callerAdminId: string,
  targetId: string,
  patch: PatchAdminInput,
  meta: ActionMeta,
): Promise<void> {
  // Self-target guards.
  if (callerAdminId === targetId) {
    if (patch.disabled === true) {
      throw new AdminMgmtError("SELF_TARGET", "You cannot disable yourself", 409);
    }
    if (patch.role !== undefined) {
      throw new AdminMgmtError("SELF_TARGET", "You cannot change your own role", 409);
    }
  }

  const db = getAdminDb();
  const [existing] = await db
    .select()
    .from(admins)
    .where(eq(admins.id, targetId))
    .limit(1);
  if (!existing) {
    throw new AdminMgmtError("NOT_FOUND", "Admin not found", 404);
  }

  const nextRole = (patch.role ?? existing.role) as AdminRole;
  const nextDisabled =
    patch.disabled === undefined ? !!existing.disabledAt : patch.disabled;

  // Last-super-admin check, but only when the mutation could reduce coverage.
  if (
    (patch.role !== undefined && patch.role !== existing.role) ||
    (patch.disabled !== undefined && patch.disabled !== !!existing.disabledAt)
  ) {
    await refuseIfLastSuperAdminCheck(targetId, nextRole, nextDisabled);
  }

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.displayName !== undefined) {
    const trimmed = patch.displayName.trim();
    if (!trimmed || trimmed.length > 80) {
      throw new AdminMgmtError("INVALID_NAME", "Display name 1-80 chars", 400);
    }
    set.displayName = trimmed;
  }
  if (patch.role !== undefined && patch.role !== existing.role) {
    set.role = patch.role;
  }
  if (patch.disabled !== undefined) {
    set.disabledAt = patch.disabled ? new Date() : null;
  }
  // Nothing changed → no-op + no audit row.
  if (Object.keys(set).length === 1) return;

  await db.update(admins).set(set).where(eq(admins.id, targetId));

  await logAuditEvent({
    adminId: callerAdminId,
    action: "admin.patch",
    targetKind: "admin",
    targetId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    before: {
      email: existing.email,
      displayName: existing.displayName,
      role: existing.role,
      disabled: !!existing.disabledAt,
    },
    after: {
      email: existing.email,
      displayName: set.displayName ?? existing.displayName,
      role: set.role ?? existing.role,
      disabled: patch.disabled !== undefined ? !!patch.disabled : !!existing.disabledAt,
    },
  });

  // Role change / disable → revoke their existing sessions so the new
  // state is felt within milliseconds, not the 8-hour session TTL.
  if (
    (patch.role !== undefined && patch.role !== existing.role) ||
    patch.disabled !== undefined
  ) {
    await revokeAllSessionsForAdmin(targetId);
  }
}

export async function deleteAdmin(
  callerAdminId: string,
  targetId: string,
  meta: ActionMeta,
): Promise<void> {
  if (callerAdminId === targetId) {
    throw new AdminMgmtError("SELF_TARGET", "You cannot delete yourself", 409);
  }
  const db = getAdminDb();
  const [existing] = await db
    .select()
    .from(admins)
    .where(eq(admins.id, targetId))
    .limit(1);
  if (!existing) {
    throw new AdminMgmtError("NOT_FOUND", "Admin not found", 404);
  }
  // Deletion is equivalent to disable+remove for super-admin coverage purposes.
  await refuseIfLastSuperAdminCheck(targetId, "ops_admin", true);

  await revokeAllSessionsForAdmin(targetId);

  // Audit BEFORE the row goes away — audit_log.admin_id FK is RESTRICT, and
  // we're deleting the *target*, not the actor, so this is fine.
  await logAuditEvent({
    adminId: callerAdminId,
    action: "admin.delete",
    targetKind: "admin",
    targetId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    before: {
      email: existing.email,
      displayName: existing.displayName,
      role: existing.role,
      disabled: !!existing.disabledAt,
    },
    after: null,
  });

  await db.delete(admins).where(eq(admins.id, targetId));
}

export async function resetAdminPassword(
  callerAdminId: string,
  targetId: string,
  meta: ActionMeta,
): Promise<{ tempPassword: string }> {
  if (callerAdminId === targetId) {
    throw new AdminMgmtError(
      "USE_ACCOUNT_PAGE",
      "Use the account page to rotate your own password",
      400,
    );
  }
  const db = getAdminDb();
  const [existing] = await db
    .select()
    .from(admins)
    .where(eq(admins.id, targetId))
    .limit(1);
  if (!existing) {
    throw new AdminMgmtError("NOT_FOUND", "Admin not found", 404);
  }

  const tempPassword = generateTempPassword();
  const hash = await hashPassword(tempPassword);

  await db
    .update(admins)
    .set({
      passwordHash: hash,
      mustRotate: true,
      // Clear lock + failed-attempt counters so the admin can log in.
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(admins.id, targetId));
  await appendPasswordHistory(targetId, hash);

  await revokeAllSessionsForAdmin(targetId);

  await logAuditEvent({
    adminId: callerAdminId,
    action: "admin.reset_password",
    targetKind: "admin",
    targetId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    before: null,
    after: { email: existing.email },
  });

  return { tempPassword };
}

// Re-exports kept for the few places that need raw `desc/isNull/ne/and`
// against the admin table in repo callers.
export { adminPasswordHistory, admins, and, desc, eq, isNull, ne };
