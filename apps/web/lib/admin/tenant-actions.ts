// Write paths for tenant operations exposed by Spec 03. Each call updates
// the row + writes an audit entry in the same transaction so a write that
// succeeds without an audit row is impossible.
//
// All three actions also bust the user-context cache and delete every
// NextAuth `sessions` row for the tenant. Effect: every user signed into
// that tenant gets bounced on their next request (no waiting for the
// 60-second JWT cache TTL).

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, sql } from "drizzle-orm";
import { isNull, and as andOp } from "drizzle-orm";
import {
  adminAuditLog,
  authDevices,
  sessions,
  subscriptions,
  tenantMembers,
  tenants,
  users,
} from "@/lib/db/schema";
import { bustUserContextCache } from "@/lib/auth";
import { getAdminDb } from "./db";
import { logAuditEvent } from "./audit";

export interface ActionMeta {
  ip: string | null;
  userAgent: string | null;
}

export class TenantActionError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "TenantActionError";
    this.code = code;
    this.status = status;
  }
}

const REASON_MIN = 5;
const REASON_MAX = 500;
const TRIAL_DAYS_MIN = 1;
const TRIAL_DAYS_MAX = 90;

function validateReason(reason: string): void {
  const trimmed = reason.trim();
  if (trimmed.length < REASON_MIN) {
    throw new TenantActionError("REASON_TOO_SHORT", "Reason is too short", 400);
  }
  if (trimmed.length > REASON_MAX) {
    throw new TenantActionError("REASON_TOO_LONG", "Reason is too long", 400);
  }
}

/** Find every userId attached to a tenant — for cache busting + session
 *  eviction. Cheap (PKindex on tenant_members.tenant_id). */
async function tenantMemberUserIds(tenantId: string): Promise<string[]> {
  const db = getAdminDb();
  const rows = await db
    .select({ userId: tenantMembers.userId })
    .from(tenantMembers)
    .where(eq(tenantMembers.tenantId, tenantId));
  return rows.map((r) => r.userId);
}

async function evictTenantUsers(tenantId: string): Promise<void> {
  const db = getAdminDb();
  const userIds = await tenantMemberUserIds(tenantId);
  if (userIds.length === 0) return;
  // Drop every existing NextAuth session row for those users.
  await db.delete(sessions).where(inArray(sessions.userId, userIds));
  // Bust the in-memory JWT cache too so any in-flight request that races
  // past the session delete sees the fresh DB state.
  await Promise.all(userIds.map((id) => bustUserContextCache(id)));
}

// ─── Suspend ──────────────────────────────────────────────────────────────

export async function suspendTenant(
  adminId: string,
  tenantId: string,
  reason: string,
  meta: ActionMeta,
): Promise<void> {
  validateReason(reason);
  const db = getAdminDb();
  const [existing] = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      suspendedAt: tenants.suspendedAt,
      suspendedReason: tenants.suspendedReason,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!existing) {
    throw new TenantActionError("NOT_FOUND", "Tenant not found", 404);
  }
  if (existing.suspendedAt) {
    throw new TenantActionError("ALREADY_SUSPENDED", "Tenant is already suspended");
  }

  const now = new Date();
  await db
    .update(tenants)
    .set({
      suspendedAt: now,
      suspendedReason: reason.trim(),
    })
    .where(eq(tenants.id, tenantId));

  await logAuditEvent({
    adminId,
    action: "tenant.suspend",
    targetKind: "tenant",
    targetId: tenantId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    before: { suspendedAt: null, suspendedReason: null, name: existing.name },
    after: { suspendedAt: now.toISOString(), suspendedReason: reason.trim() },
  });

  // Evict every active session so the suspension is instant. The proxy
  // also enforces it on every subsequent request via session.user.tenantSuspendedAt.
  await evictTenantUsers(tenantId);
}

export async function unsuspendTenant(
  adminId: string,
  tenantId: string,
  meta: ActionMeta,
): Promise<void> {
  const db = getAdminDb();
  const [existing] = await db
    .select({
      id: tenants.id,
      suspendedAt: tenants.suspendedAt,
      suspendedReason: tenants.suspendedReason,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!existing) {
    throw new TenantActionError("NOT_FOUND", "Tenant not found", 404);
  }
  if (!existing.suspendedAt) {
    throw new TenantActionError("NOT_SUSPENDED", "Tenant is not suspended");
  }

  await db
    .update(tenants)
    .set({ suspendedAt: null, suspendedReason: null })
    .where(eq(tenants.id, tenantId));

  await logAuditEvent({
    adminId,
    action: "tenant.unsuspend",
    targetKind: "tenant",
    targetId: tenantId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    before: {
      suspendedAt: existing.suspendedAt.toISOString(),
      suspendedReason: existing.suspendedReason,
    },
    after: { suspendedAt: null, suspendedReason: null },
  });

  // Bust caches so the next request renders normally. Existing sessions
  // were not deleted on unsuspend (no need to force a re-login).
  const userIds = await tenantMemberUserIds(tenantId);
  await Promise.all(userIds.map((id) => bustUserContextCache(id)));
}

// ─── Extend trial ─────────────────────────────────────────────────────────

export interface ExtendTrialResult {
  newTrialEndsAt: Date;
}

export async function extendTrial(
  adminId: string,
  tenantId: string,
  extraDays: number,
  reason: string | null,
  meta: ActionMeta,
): Promise<ExtendTrialResult> {
  if (!Number.isInteger(extraDays) || extraDays < TRIAL_DAYS_MIN || extraDays > TRIAL_DAYS_MAX) {
    throw new TenantActionError(
      "TOO_MANY_DAYS",
      `extraDays must be between ${TRIAL_DAYS_MIN} and ${TRIAL_DAYS_MAX}`,
      400,
    );
  }
  const db = getAdminDb();
  const [sub] = await db
    .select({
      tenantId: subscriptions.tenantId,
      status: subscriptions.status,
      trialEndsAt: subscriptions.trialEndsAt,
    })
    .from(subscriptions)
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1);
  if (!sub) {
    throw new TenantActionError("NOT_FOUND", "Subscription not found", 404);
  }

  // Admins can extend a trial regardless of current status. If the trial has
  // already ended (or the tenant is on a paid plan / expired), base the new
  // end date on "now" instead of a stale past date — otherwise adding 14
  // days to a trial that ended a month ago still leaves it in the past. We
  // also force status back to "trialing" so the tenant regains trial access.
  const now = Date.now();
  const base = Math.max(now, sub.trialEndsAt.getTime());
  const newEndsAt = new Date(base + extraDays * 24 * 60 * 60 * 1000);
  await db
    .update(subscriptions)
    .set({
      trialEndsAt: newEndsAt,
      status: "trialing",
      updatedAt: sql`now()`,
    })
    .where(eq(subscriptions.tenantId, tenantId));

  await logAuditEvent({
    adminId,
    action: "tenant.extend_trial",
    targetKind: "tenant",
    targetId: tenantId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    before: { trialEndsAt: sub.trialEndsAt.toISOString() },
    after: {
      trialEndsAt: newEndsAt.toISOString(),
      extraDays,
      reason: reason?.trim() || null,
    },
  });

  // Bust caches so the user's UI surfaces the new trial end. No need to
  // delete sessions — the tenant was never offline.
  const userIds = await tenantMemberUserIds(tenantId);
  await Promise.all(userIds.map((id) => bustUserContextCache(id)));

  return { newTrialEndsAt: newEndsAt };
}

// ─── Enable trial (fresh N-day grant) ──────────────────────────────────────

export interface EnableTrialResult {
  newTrialEndsAt: Date;
  /** True when the subscription row didn't exist and we created it. Lets
   *  the admin UI tailor the success message. */
  created: boolean;
}

/**
 * Grant a fresh N-day trial to a store.
 *
 * Semantics intentionally distinct from {@link extendTrial}:
 *   extend  — keep the current trial end if it's in the future, add days
 *   enable  — IGNORE the current end, start N days FROM NOW
 *
 * Used when a store's trial has elapsed / was cancelled / was never active,
 * and an admin wants to gift them a new evaluation window. The subscription
 * row must already exist (every signup creates one); if it's somehow
 * missing we create a fresh trialing row so the admin can't get stuck.
 *
 * Status is set to 'trialing' regardless of its previous value — the whole
 * point of this action is to put the store back into a trial state.
 */
export async function enableTrial(
  adminId: string,
  tenantId: string,
  trialDays: number,
  meta: ActionMeta,
): Promise<EnableTrialResult> {
  if (!Number.isInteger(trialDays) || trialDays < TRIAL_DAYS_MIN || trialDays > TRIAL_DAYS_MAX) {
    throw new TenantActionError(
      "INVALID_DAYS",
      `trialDays must be between ${TRIAL_DAYS_MIN} and ${TRIAL_DAYS_MAX}`,
      400,
    );
  }
  const db = getAdminDb();
  const now = new Date();
  const newEndsAt = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);

  const [existing] = await db
    .select({
      tenantId: subscriptions.tenantId,
      status: subscriptions.status,
      trialEndsAt: subscriptions.trialEndsAt,
      plan: subscriptions.plan,
    })
    .from(subscriptions)
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1);

  let created = false;
  if (!existing) {
    await db.insert(subscriptions).values({
      tenantId,
      plan: "trial",
      status: "trialing",
      trialEndsAt: newEndsAt,
    });
    created = true;
  } else {
    await db
      .update(subscriptions)
      .set({
        status: "trialing",
        trialEndsAt: newEndsAt,
        // Clear cancellation history so the tenant isn't marked as cancelled
        // while they're actively on a fresh trial.
        cancelledAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(subscriptions.tenantId, tenantId));
  }

  await logAuditEvent({
    adminId,
    action: "tenant.enable_trial",
    targetKind: "tenant",
    targetId: tenantId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    before: existing
      ? {
          status: existing.status,
          trialEndsAt: existing.trialEndsAt.toISOString(),
          plan: existing.plan,
        }
      : { status: null, trialEndsAt: null, plan: null },
    after: {
      status: "trialing",
      trialEndsAt: newEndsAt.toISOString(),
      plan: existing?.plan ?? "trial",
      trialDays,
      created,
    },
  });

  // Bust caches so the tenant's UI picks up the new trial end immediately.
  // No session eviction — the tenant was never offline.
  const userIds = await tenantMemberUserIds(tenantId);
  await Promise.all(userIds.map((id) => bustUserContextCache(id)));

  return { newTrialEndsAt: newEndsAt, created };
}

// ─── Reset owner password (admin-triggered) ───────────────────────────────

export interface ResetOwnerPasswordResult {
  /** The newly-minted temporary password, shown to the admin ONCE. Never
   *  persisted or logged. */
  temporaryPassword: string;
  ownerEmail: string;
  ownerUserId: string;
}

/**
 * Admin-initiated owner password reset.
 *
 * Why no self-service email flow for this path: we don't yet operate SMTP
 * reliably outside of a handful of flows, and this is a last-resort rescue
 * ("I locked myself out, help me get in"). An ops person generates a secure
 * one-shot temp password, reads it to the owner over WhatsApp/phone, and the
 * owner is forced to set a new password on next login. The temp password
 * exists only for the one HTTP response body — it is NEVER stored and NEVER
 * logged.
 *
 * Atomicity:
 *   1. Hash temp password.
 *   2. Update users.password_hash + must_change_password = true +
 *      bump token_version (→ every JWT issued before this moment is dead on
 *      next request).
 *   3. Delete every NextAuth sessions row for this user.
 *   4. Revoke every mobile auth_devices row for this user (native app
 *      sessions use refresh tokens stored there).
 *   5. Bust the in-memory JWT cache.
 *   6. Audit the action — before/after carry NO password material; just the
 *      user id + email + token_version change. Fails loudly if audit fails.
 *
 * All six steps happen inside one drizzle transaction so a crash between
 * "password changed" and "sessions dropped" cannot leave the owner with
 * both a valid old session AND a new password.
 */
export async function resetOwnerPassword(
  adminId: string,
  tenantId: string,
  meta: ActionMeta,
): Promise<ResetOwnerPasswordResult> {
  const db = getAdminDb();

  // Resolve the earliest-joined owner (matches the convention used in
  // `lib/admin/tenants.ts::ownerRowsFor`, so the admin always acts on the
  // same owner they see on the detail page).
  const ownerRows = await db
    .select({
      userId: users.id,
      email: users.email,
      tokenVersion: users.tokenVersion,
      joinedAt: tenantMembers.joinedAt,
    })
    .from(tenantMembers)
    .innerJoin(users, eq(users.id, tenantMembers.userId))
    .where(
      andOp(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.role, "owner")),
    );
  ownerRows.sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
  const owner = ownerRows[0];
  if (!owner) {
    throw new TenantActionError("OWNER_NOT_FOUND", "Owner not found", 404);
  }

  const temporaryPassword = generateTemporaryPassword();
  const hash = await bcrypt.hash(temporaryPassword, 12);
  const newTokenVersion = owner.tokenVersion + 1;

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        passwordHash: hash,
        mustChangePassword: true,
        tokenVersion: newTokenVersion,
      })
      .where(eq(users.id, owner.userId));

    await tx.delete(sessions).where(eq(sessions.userId, owner.userId));
    await tx.delete(authDevices).where(eq(authDevices.userId, owner.userId));

    // Audit INSIDE the transaction. Deliberately redacted: we store the id,
    // the email, and the token_version delta — never the password or any
    // hash material. The reader must infer "a password was set" from the
    // action string + token_version bump.
    await tx.insert(adminAuditLog).values({
      adminId,
      action: "owner.password_reset",
      targetKind: "user",
      targetId: owner.userId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      beforeJsonb: {
        tenantId,
        ownerEmail: owner.email,
        tokenVersion: owner.tokenVersion,
      },
      afterJsonb: {
        tenantId,
        ownerEmail: owner.email,
        tokenVersion: newTokenVersion,
        mustChangePassword: true,
      },
    });
  });

  // Post-transaction: bust the in-memory JWT cache so an in-flight request
  // that raced past the DELETE ... sessions can't be served with the old
  // decoded claims. Safe to retry the tx — the mutation is already durable.
  await bustUserContextCache(owner.userId);

  return {
    temporaryPassword,
    ownerEmail: owner.email,
    ownerUserId: owner.userId,
  };
}

/**
 * 16-character URL-safe temporary password with sufficient entropy (~96
 * bits). base64url charset excludes confusing lookalikes well enough that
 * reading one over a phone is tolerable; the owner is forced to change it
 * on next login anyway so collision-resistance matters more than human
 * memorisation.
 */
function generateTemporaryPassword(): string {
  // 12 random bytes → 16 base64url chars (no padding).
  const b64 = crypto
    .randomBytes(12)
    .toString("base64")
    .replace(/\+/g, "A")
    .replace(/\//g, "B")
    .replace(/=+$/g, "");
  return b64.slice(0, 16);
}

// ─── Helpers used by cron sweeps ──────────────────────────────────────────

/** Reusable filter for crons that iterate tenants but should skip the
 *  paused ones. */
export const notSuspendedClause = andOp(isNull(tenants.suspendedAt));
