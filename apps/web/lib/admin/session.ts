// Admin session helpers — token generation, cookie I/O, server-side session
// lookup. Separate from tenant NextAuth so a cookie collision is impossible.

import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { adminSessions, admins } from "@/lib/db/schema";
import { getAdminDb } from "./db";
import { ADMIN_SESSION_COOKIE } from "./cookie";
// Re-exported so existing route imports stay valid. Edge code that needs only
// the constant should import from `./cookie` directly.
export { ADMIN_SESSION_COOKIE };

/** Session lengths from spec §2.1. */
export const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000;     // 2 h
export const SESSION_ABS_TTL_MS = 8 * 60 * 60 * 1000;      // 8 h

export interface ResolvedAdminSession {
  sessionId: string;
  adminId: string;
  adminEmail: string;
  adminRole: "super_admin" | "ops_admin";
  mustRotate: boolean;
  displayName: string | null;
  expiresAt: Date;
}

/** 32 raw bytes → base64url. The `session_token` column carries this. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Create a new admin_sessions row and return the token to put in a cookie. */
export async function createSession(args: {
  adminId: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const db = getAdminDb();
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_ABS_TTL_MS);
  await db.insert(adminSessions).values({
    adminId: args.adminId,
    sessionToken: token,
    ip: args.ip,
    userAgent: args.userAgent,
    expiresAt,
  });
  return { token, expiresAt };
}

/** Resolve the current request's session from the cookie. Returns null when
 *  there's no cookie, no matching row, or the row has expired. Bumps
 *  last_seen_at on every hit (cheap; the index covers the predicate). */
export async function resolveSessionFromCookies(): Promise<ResolvedAdminSession | null> {
  const c = await cookies();
  const token = c.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return null;
  return resolveSession(token);
}

/** Variant that takes a raw token — handy in the proxy where the cookie
 *  store isn't available the same way. */
export async function resolveSession(
  token: string,
): Promise<ResolvedAdminSession | null> {
  const db = getAdminDb();
  const now = new Date();
  const rows = await db
    .select({
      sessionId: adminSessions.id,
      adminId: adminSessions.adminId,
      adminEmail: admins.email,
      adminRole: admins.role,
      mustRotate: admins.mustRotate,
      displayName: admins.displayName,
      disabledAt: admins.disabledAt,
      expiresAt: adminSessions.expiresAt,
      lastSeenAt: adminSessions.lastSeenAt,
    })
    .from(adminSessions)
    .innerJoin(admins, eq(admins.id, adminSessions.adminId))
    .where(
      and(
        eq(adminSessions.sessionToken, token),
        gt(adminSessions.expiresAt, now),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.disabledAt) return null;
  // Idle TTL — sliding 2h window. Beyond it, the session is dead even if
  // the absolute expires_at is in the future.
  const idleCutoff = new Date(Date.now() - SESSION_IDLE_TTL_MS);
  if (row.lastSeenAt < idleCutoff) return null;
  // Touch last_seen_at. Fire and forget — failure here doesn't invalidate
  // the session.
  db
    .update(adminSessions)
    .set({ lastSeenAt: now })
    .where(eq(adminSessions.id, row.sessionId))
    .catch(() => {});
  return {
    sessionId: row.sessionId,
    adminId: row.adminId,
    adminEmail: row.adminEmail,
    adminRole: row.adminRole as "super_admin" | "ops_admin",
    mustRotate: row.mustRotate,
    displayName: row.displayName,
    expiresAt: row.expiresAt,
  };
}

/** Revoke a single session (current sign-out). */
export async function revokeSession(sessionId: string): Promise<void> {
  const db = getAdminDb();
  await db.delete(adminSessions).where(eq(adminSessions.id, sessionId));
}

/** Revoke every session belonging to an admin (sign-out-everywhere, also
 *  used by Specs 05 + 07 to evict a target admin after role / password
 *  changes). */
export async function revokeAllSessionsForAdmin(adminId: string): Promise<void> {
  const db = getAdminDb();
  await db.delete(adminSessions).where(eq(adminSessions.adminId, adminId));
}

/** Best-effort IP extraction. Same heuristics as the cron helper. */
export async function readRequestIp(): Promise<string | null> {
  const h = await headers();
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = h.get("x-real-ip");
  if (real) return real.trim();
  return null;
}

export async function readUserAgent(): Promise<string | null> {
  const h = await headers();
  return h.get("user-agent");
}
