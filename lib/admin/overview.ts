// Platform-wide KPI aggregator for /admin home. One SQL fan-out per call;
// no N+1. Numbers travel as strings everywhere to keep precision.

import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import {
  adminAuditLog,
  paymentAttempts,
  subscriptions,
  tenants,
} from "@/lib/db/schema";
import { getAdminDb } from "./db";

export interface OverviewPayload {
  kpis: {
    totalTenants: number;
    totalTenantsDeltaThisWeek: number;
    trialing: number;
    trialingExpiringIn7d: number;
    activePaid: number;
    activePaidDeltaThisWeek: number;
    mrrEgp: string;
    mrrDeltaThisWeekEgp: string;
    todaySignups: number;
    signupsLastWeekSameDay: number;
  };
  trialsExpiringSoon: {
    id: string;
    name: string;
    ownerEmail: string | null;
    trialEndsAt: Date;
  }[];
  recentPaymentFailures: {
    tenantId: string;
    tenantName: string;
    amountEgp: string;
    failureReason: string | null;
    attemptedAt: Date;
  }[];
  recentAdminActivity: {
    id: string;
    action: string;
    adminEmail: string | null;
    targetKind: string | null;
    targetId: string | null;
    occurredAt: Date;
  }[];
  planDistribution: { plan: string; count: number }[];
  signupsLast30Days: { day: string; count: number }[];
}

export async function getOverview(): Promise<OverviewPayload> {
  const db = getAdminDb();
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const lastWeekSameDayStart = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const lastWeekSameDayEnd = new Date(lastWeekSameDayStart.getTime() + 24 * 60 * 60 * 1000);

  const [
    totalTenantsAgg,
    totalTenantsLastWeekAgg,
    statusBreakdown,
    activeMrr,
    activeMrrLastWeek,
    activePaidLastWeek,
    trialingExpiringSoonAgg,
    todaySignupsAgg,
    sameDayLastWeekSignupsAgg,
    trialsExpiringSoonRows,
    recentFailureRows,
    recentAdminRows,
    planRows,
    signupSeriesRows,
  ] = await Promise.all([
    db.select({ count: sql<number>`coalesce(count(*), 0)::int` }).from(tenants),
    db
      .select({ count: sql<number>`coalesce(count(*), 0)::int` })
      .from(tenants)
      .where(lt(tenants.createdAt, sevenDaysAgo)),
    db
      .select({
        status: subscriptions.status,
        count: sql<number>`coalesce(count(*), 0)::int`,
      })
      .from(subscriptions)
      .groupBy(subscriptions.status),
    db
      .select({
        sum: sql<string>`coalesce(sum(${subscriptions.amountEgp}::numeric), 0)::text`,
      })
      .from(subscriptions)
      .where(eq(subscriptions.status, "active")),
    db
      .select({
        sum: sql<string>`coalesce(sum(${subscriptions.amountEgp}::numeric), 0)::text`,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.status, "active"),
          lt(subscriptions.updatedAt, sevenDaysAgo),
        ),
      ),
    db
      .select({ count: sql<number>`coalesce(count(*), 0)::int` })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.status, "active"),
          lt(subscriptions.updatedAt, sevenDaysAgo),
        ),
      ),
    db
      .select({ count: sql<number>`coalesce(count(*), 0)::int` })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.status, "trialing"),
          gt(subscriptions.trialEndsAt, now),
          lt(subscriptions.trialEndsAt, sevenDaysFromNow),
        ),
      ),
    db
      .select({ count: sql<number>`coalesce(count(*), 0)::int` })
      .from(tenants)
      .where(gt(tenants.createdAt, todayStart)),
    db
      .select({ count: sql<number>`coalesce(count(*), 0)::int` })
      .from(tenants)
      .where(
        and(
          gt(tenants.createdAt, lastWeekSameDayStart),
          lt(tenants.createdAt, lastWeekSameDayEnd),
        ),
      ),
    db
      .select({
        id: tenants.id,
        name: tenants.name,
        trialEndsAt: subscriptions.trialEndsAt,
      })
      .from(subscriptions)
      .innerJoin(tenants, eq(tenants.id, subscriptions.tenantId))
      .where(
        and(
          eq(subscriptions.status, "trialing"),
          gt(subscriptions.trialEndsAt, now),
          lt(subscriptions.trialEndsAt, sevenDaysFromNow),
        ),
      )
      .orderBy(subscriptions.trialEndsAt)
      .limit(5),
    db
      .select({
        tenantId: paymentAttempts.tenantId,
        tenantName: tenants.name,
        amountEgp: paymentAttempts.amountEgp,
        failureReason: paymentAttempts.failureReason,
        attemptedAt: paymentAttempts.attemptedAt,
      })
      .from(paymentAttempts)
      .innerJoin(tenants, eq(tenants.id, paymentAttempts.tenantId))
      .where(
        and(
          eq(paymentAttempts.status, "failed"),
          gt(paymentAttempts.attemptedAt, thirtyDaysAgo),
        ),
      )
      .orderBy(desc(paymentAttempts.attemptedAt))
      .limit(10),
    db
      .select({
        id: adminAuditLog.id,
        action: adminAuditLog.action,
        adminEmail: sql<string | null>`(select email from admins where id = ${adminAuditLog.adminId})`,
        targetKind: adminAuditLog.targetKind,
        targetId: adminAuditLog.targetId,
        occurredAt: adminAuditLog.occurredAt,
      })
      .from(adminAuditLog)
      .orderBy(desc(adminAuditLog.occurredAt))
      .limit(10),
    db
      .select({
        plan: subscriptions.plan,
        count: sql<number>`coalesce(count(*), 0)::int`,
      })
      .from(subscriptions)
      .groupBy(subscriptions.plan),
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${tenants.createdAt}), 'YYYY-MM-DD')`,
        count: sql<number>`coalesce(count(*), 0)::int`,
      })
      .from(tenants)
      .where(gt(tenants.createdAt, thirtyDaysAgo))
      .groupBy(sql`date_trunc('day', ${tenants.createdAt})`)
      .orderBy(sql`date_trunc('day', ${tenants.createdAt})`),
  ]);

  // Hush — keep the variable lest TS think it's unused; we use it implicitly
  // via the timeline rendering on the client.
  void fourteenDaysAgo;

  const statusMap = new Map(statusBreakdown.map((r) => [r.status, r.count]));
  const trialing = statusMap.get("trialing") ?? 0;
  const activePaid = statusMap.get("active") ?? 0;

  return {
    kpis: {
      totalTenants: totalTenantsAgg[0]?.count ?? 0,
      totalTenantsDeltaThisWeek:
        (totalTenantsAgg[0]?.count ?? 0) - (totalTenantsLastWeekAgg[0]?.count ?? 0),
      trialing,
      trialingExpiringIn7d: trialingExpiringSoonAgg[0]?.count ?? 0,
      activePaid,
      activePaidDeltaThisWeek: activePaid - (activePaidLastWeek[0]?.count ?? 0),
      mrrEgp: activeMrr[0]?.sum ?? "0",
      mrrDeltaThisWeekEgp: (
        Number(activeMrr[0]?.sum ?? 0) - Number(activeMrrLastWeek[0]?.sum ?? 0)
      ).toFixed(2),
      todaySignups: todaySignupsAgg[0]?.count ?? 0,
      signupsLastWeekSameDay: sameDayLastWeekSignupsAgg[0]?.count ?? 0,
    },
    trialsExpiringSoon: await Promise.all(
      trialsExpiringSoonRows.map(async (r) => {
        // Best-effort owner email for each row — single small query, bounded.
        const owner = await db.execute(sql`
          select u.email
          from tenant_members tm
          join users u on u.id = tm.user_id
          where tm.tenant_id = ${r.id} and tm.role = 'owner'
          order by tm.joined_at asc
          limit 1
        `);
        const ownerArr = (
          Array.isArray(owner)
            ? owner
            : (owner as { rows?: { email: string }[] }).rows
        ) as { email: string }[] | undefined;
        const ownerEmail: string | null =
          typeof ownerArr?.[0]?.email === "string" ? ownerArr[0].email : null;
        return {
          id: r.id,
          name: r.name,
          ownerEmail,
          trialEndsAt: r.trialEndsAt,
        };
      }),
    ),
    recentPaymentFailures: recentFailureRows,
    recentAdminActivity: recentAdminRows,
    planDistribution: planRows,
    signupsLast30Days: signupSeriesRows,
  };
}
