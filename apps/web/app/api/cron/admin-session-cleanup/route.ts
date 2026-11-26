import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { admins, adminSessions } from "@/lib/db/schema";
import { getAdminDb } from "@/lib/admin/db";
import { guardCronRequest } from "@/lib/cron/auth";

// Daily 03:30 UTC sweep:
//   - delete admin_sessions past expires_at
//   - lock admins with > 10 failed attempts for 1 hour
//   - log loud warning if bootstrap admin still hasn't rotated past 7 days
//
// Subsequent specs (07 impersonation) extend this with their own checks; the
// route stays the single hourly entry point for admin-side housekeeping.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const blocked = await guardCronRequest(req, {
    bucket: "cron.admin_session_cleanup",
  });
  if (blocked) return blocked;

  const db = getAdminDb();
  const now = new Date();

  // 1. Delete expired sessions.
  const deleted = await db
    .delete(adminSessions)
    .where(lt(adminSessions.expiresAt, now))
    .returning({ id: adminSessions.id });

  // 2. Lock excessive-failure admins for 1 hour.
  const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
  const locked = await db
    .update(admins)
    .set({ lockedUntil: oneHourFromNow })
    .where(
      and(
        gt(admins.failedAttempts, 10),
        // Don't extend an already-active lockout.
        sql`(${admins.lockedUntil} IS NULL OR ${admins.lockedUntil} < now())`,
      ),
    )
    .returning({ id: admins.id });

  // 3. Detect bootstrap admin still on default + 7 days old. In production
  // we want this to scream loudly; the actual refuse-to-boot lives in the
  // server-bootstrap path (Spec 01 §3.2). Here we just emit a structured log.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const overdueBootstrap = await db
    .select({ id: admins.id, email: admins.email, createdAt: admins.createdAt })
    .from(admins)
    .where(
      and(
        eq(admins.mustRotate, true),
        lt(admins.createdAt, sevenDaysAgo),
      ),
    );
  if (overdueBootstrap.length > 0) {
    console.warn(
      "[cron/admin-session-cleanup] WARNING: bootstrap admin(s) overdue for password rotation:",
      overdueBootstrap.map((a) => ({ id: a.id, email: a.email, createdAt: a.createdAt })),
    );
  }

  return NextResponse.json({
    ok: true,
    deletedSessions: deleted.length,
    lockedAdmins: locked.length,
    overdueRotation: overdueBootstrap.length,
  });
}
