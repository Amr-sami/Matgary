// Spec 07 — admin impersonation. Stores one-time signing tokens in Redis so
// the NextAuth credentials provider can validate them server-side without
// also accepting a password. The token lifetime IS the impersonation
// session lifetime: 30 minutes hard cap, no extension.
//
// We do NOT add a new DB table for state; the audit trail lives in
// admin_audit_log via the start/end/timeout actions, and the in-flight
// state is a Redis key. This keeps Spec 07 to zero schema changes.

import { randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { tenantMembers, tenants, users } from "@/lib/db/schema";
import { getAdminDb } from "./db";
import { redis } from "@/lib/redis";
import { globalKey } from "@/lib/cache";

/** 30-minute hard cap on every impersonation session. */
export const IMPERSONATION_TTL_SEC = 30 * 60;

export class ImpersonationError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface ImpersonationContext {
  /** Random opaque token used as the Redis key + handed to authorize(). */
  token: string;
  /** Admin who initiated the impersonation. */
  adminId: string;
  /** Snapshot at start time — survives the admin row being deleted later. */
  adminEmail: string;
  /** Tenant being impersonated. */
  tenantId: string;
  /** The actual user.id the JWT will be issued for (the tenant's owner). */
  ownerUserId: string;
  /** Started + expires (epoch ms). */
  startedAt: number;
  expiresAt: number;
}

const TOKEN_PREFIX = globalKey("impersonation", "token");
const SESSION_PREFIX = globalKey("impersonation", "session");

function tokenKey(token: string) {
  return `${TOKEN_PREFIX}:${token}`;
}

function sessionKey(sessionId: string) {
  return `${SESSION_PREFIX}:${sessionId}`;
}

/** Pick the owner an admin should be impersonating. Earliest-joined owner
 *  wins when there's more than one — same rule the tenant-detail page uses. */
async function pickOwner(tenantId: string): Promise<{ userId: string; disabled: boolean } | null> {
  const db = getAdminDb();
  const rows = await db
    .select({
      userId: tenantMembers.userId,
      joinedAt: tenantMembers.joinedAt,
    })
    .from(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.role, "owner")))
    .orderBy(asc(tenantMembers.joinedAt));
  if (rows.length === 0) return null;
  const owner = rows[0];
  // Owner enabled/disabled — currently the `users` table has no disabled
  // flag (the tenant disables a member by removing them from
  // tenant_members). For Spec 07 we treat "no membership at all" as
  // disabled. Future: a real users.disabled_at would land here.
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, owner.userId))
    .limit(1);
  return { userId: owner.userId, disabled: !u };
}

/** Validate the target tenant + owner and stage a one-time impersonation
 *  token in Redis. The caller then redirects through the NextAuth signin
 *  endpoint to actually mint the JWT. */
export async function prepareImpersonation(args: {
  adminId: string;
  adminEmail: string;
  tenantId: string;
}): Promise<ImpersonationContext> {
  const db = getAdminDb();
  const [tenant] = await db
    .select({
      id: tenants.id,
      suspendedAt: tenants.suspendedAt,
    })
    .from(tenants)
    .where(eq(tenants.id, args.tenantId))
    .limit(1);
  if (!tenant) {
    throw new ImpersonationError("TENANT_NOT_FOUND", "Tenant not found", 404);
  }
  if (tenant.suspendedAt) {
    throw new ImpersonationError(
      "TENANT_SUSPENDED",
      "Unsuspend the tenant before impersonating the owner.",
    );
  }

  const owner = await pickOwner(args.tenantId);
  if (!owner) {
    throw new ImpersonationError("NO_OWNER", "Tenant has no owner to impersonate.", 409);
  }
  if (owner.disabled) {
    throw new ImpersonationError("OWNER_DISABLED", "Owner account is disabled.", 409);
  }

  const token = randomBytes(32).toString("base64url");
  const startedAt = Date.now();
  const expiresAt = startedAt + IMPERSONATION_TTL_SEC * 1000;
  const ctx: ImpersonationContext = {
    token,
    adminId: args.adminId,
    adminEmail: args.adminEmail,
    tenantId: args.tenantId,
    ownerUserId: owner.userId,
    startedAt,
    expiresAt,
  };

  if (!redis) {
    // Redis is opportunistic for the rest of the app but it's load-bearing
    // here — without it we have nowhere to stash the one-time token.
    throw new ImpersonationError(
      "REDIS_UNAVAILABLE",
      "Cache layer is unavailable; impersonation requires Redis.",
      503,
    );
  }
  await redis.set(
    tokenKey(token),
    JSON.stringify(ctx),
    "EX",
    IMPERSONATION_TTL_SEC,
  );
  return ctx;
}

/** Validate + atomically consume a token. Returns the impersonation context
 *  or null when the token doesn't exist / expired / already consumed.
 *
 *  On success we ALSO store the same payload under a `sessionId` key so the
 *  exit endpoint can look up the impersonation context without re-reading
 *  the (now-deleted) token. The sessionId is a different random value
 *  embedded into the JWT — it's the only handle the running tenant session
 *  has back to the original admin. */
export async function consumeImpersonationToken(
  token: string,
): Promise<(ImpersonationContext & { sessionId: string }) | null> {
  if (!redis) return null;
  const raw = await redis.get(tokenKey(token));
  if (!raw) return null;
  // Atomically remove so the token is single-use.
  const deleted = await redis.del(tokenKey(token));
  if (deleted === 0) return null;
  const ctx = JSON.parse(raw) as ImpersonationContext;
  const sessionId = randomBytes(16).toString("base64url");
  const ttl = Math.max(
    60,
    Math.floor((ctx.expiresAt - Date.now()) / 1000),
  );
  await redis.set(sessionKey(sessionId), JSON.stringify(ctx), "EX", ttl);
  return { ...ctx, sessionId };
}

/** Read the impersonation context for an active session id. Used by the
 *  exit endpoint to attribute the `impersonate.end` audit row. */
export async function getImpersonationSession(
  sessionId: string,
): Promise<ImpersonationContext | null> {
  if (!redis) return null;
  const raw = await redis.get(sessionKey(sessionId));
  if (!raw) return null;
  return JSON.parse(raw) as ImpersonationContext;
}

/** Drop an impersonation session. Called by the exit endpoint. */
export async function endImpersonationSession(sessionId: string): Promise<void> {
  if (!redis) return;
  await redis.del(sessionKey(sessionId));
}
