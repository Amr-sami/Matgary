// Per-tenant Health Flags rollup. Surfaces signals from the cross-cutting
// features (cash reconciliation, daily digest, cash shifts, sales activity)
// so admin support sees the same picture the owner would.

import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import {
  branches,
  cashShifts,
  digestSettings,
  sales,
  shopSettings,
  users,
} from "@/lib/db/schema";
import { getAdminDb } from "./db";

export type HealthFlagSeverity = "ok" | "warn";

export interface HealthFlag {
  key:
    | "cash_reconciliation_off"
    | "cash_shifts_open_too_long"
    | "digest_not_configured"
    | "no_sales_7d"
    | "dormant_employees_30d";
  severity: HealthFlagSeverity;
  /** Numeric detail used by the UI (e.g. count of stale shifts). */
  value: number;
}

export async function computeHealthFlags(tenantId: string): Promise<HealthFlag[]> {
  const db = getAdminDb();
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    branchTotal,
    reconciliationOnBranches,
    staleShifts,
    digestRow,
    lastSale,
    dormantEmployees,
  ] = await Promise.all([
    db
      .select({ count: sql<number>`coalesce(count(*), 0)::int` })
      .from(branches)
      .where(eq(branches.tenantId, tenantId)),
    db
      .select({ count: sql<number>`coalesce(count(*), 0)::int` })
      .from(shopSettings)
      .where(
        and(
          eq(shopSettings.tenantId, tenantId),
          eq(shopSettings.cashReconciliationEnabled, true),
        ),
      ),
    db
      .select({ count: sql<number>`coalesce(count(*), 0)::int` })
      .from(cashShifts)
      .where(
        and(
          eq(cashShifts.tenantId, tenantId),
          eq(cashShifts.status, "open"),
          lt(cashShifts.openedAt, twentyFourHoursAgo),
        ),
      ),
    db
      .select()
      .from(digestSettings)
      .where(eq(digestSettings.tenantId, tenantId))
      .limit(1),
    db
      .select({ lastSaleAt: sql<Date | null>`max(${sales.saleDate})` })
      .from(sales)
      .where(eq(sales.tenantId, tenantId)),
    // Employees with no recent activity. We approximate "last seen" by
    // joining via tenant_members → users → activityLogs to find the most
    // recent activity row per user. Users with no activity row in the last
    // 30 days are flagged. Single query via NOT EXISTS subquery.
    // The cutoff is interpolated as an ISO literal — postgres.js' raw
    // execute path refuses raw Date params here.
    db.execute(sql`
      select count(distinct tm.user_id)::int as count
      from tenant_members tm
      where tm.tenant_id = ${tenantId}
        and not exists (
          select 1
          from activity_logs al
          where al.actor_user_id = tm.user_id
            and al.tenant_id = tm.tenant_id
            and al.created_at > ${thirtyDaysAgo.toISOString()}::timestamptz
        )
    `),
  ]);

  const branches_ = branchTotal[0]?.count ?? 0;
  const reconciledOn = reconciliationOnBranches[0]?.count ?? 0;
  const staleCount = staleShifts[0]?.count ?? 0;
  const digest = digestRow[0];
  const lastSaleAt = lastSale[0]?.lastSaleAt ?? null;
  // Drizzle's sql.execute returns either an array or { rows: [...] } depending
  // on the driver. Normalise.
  const dormantArr = Array.isArray(dormantEmployees)
    ? (dormantEmployees as unknown as { count: number }[])
    : (dormantEmployees as unknown as { rows: { count: number }[] }).rows;
  const dormantCount = Number(dormantArr?.[0]?.count ?? 0);

  // Suppress fallback unused locals warning.
  void now;

  const flags: HealthFlag[] = [];
  flags.push({
    key: "cash_reconciliation_off",
    severity: branches_ > 0 && reconciledOn === 0 ? "warn" : "ok",
    value: branches_ - reconciledOn,
  });
  flags.push({
    key: "cash_shifts_open_too_long",
    severity: staleCount > 0 ? "warn" : "ok",
    value: staleCount,
  });
  flags.push({
    key: "digest_not_configured",
    severity:
      !digest || !digest.enabled || !digest.ownerPhone ? "warn" : "ok",
    value: digest?.enabled ? 0 : 1,
  });
  flags.push({
    key: "no_sales_7d",
    severity: !lastSaleAt || new Date(lastSaleAt) < sevenDaysAgo ? "warn" : "ok",
    value: lastSaleAt
      ? Math.floor((Date.now() - new Date(lastSaleAt).getTime()) / (24 * 60 * 60 * 1000))
      : 999,
  });
  flags.push({
    key: "dormant_employees_30d",
    severity: dormantCount > 0 ? "warn" : "ok",
    value: dormantCount,
  });

  return flags;
}
