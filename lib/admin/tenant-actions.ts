// Write paths for tenant operations exposed by Spec 03. Each call updates
// the row + writes an audit entry in the same transaction so a write that
// succeeds without an audit row is impossible.
//
// All three actions also bust the user-context cache and delete every
// NextAuth `sessions` row for the tenant. Effect: every user signed into
// that tenant gets bounced on their next request (no waiting for the
// 60-second JWT cache TTL).

import { eq, inArray, sql } from "drizzle-orm";
import { isNull, and as andOp } from "drizzle-orm";
import { sessions, subscriptions, tenantMembers, tenants } from "@/lib/db/schema";
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
  if (sub.status !== "trialing") {
    throw new TenantActionError(
      "NOT_TRIALING",
      "Trial can only be extended while the subscription is in 'trialing' state.",
    );
  }

  const newEndsAt = new Date(sub.trialEndsAt.getTime() + extraDays * 24 * 60 * 60 * 1000);
  await db
    .update(subscriptions)
    .set({ trialEndsAt: newEndsAt, updatedAt: sql`now()` })
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

// ─── Helpers used by cron sweeps ──────────────────────────────────────────

/** Reusable filter for crons that iterate tenants but should skip the
 *  paused ones. */
export const notSuspendedClause = andOp(isNull(tenants.suspendedAt));
