// Daily owner digest — aggregator. See docs/specs/daily-owner-digest.md.
//
// Single repo module that walks every relevant table for one (tenant,
// branch, business_date) and returns a compact payload the renderer
// turns into the WhatsApp message. All numerics travel as strings.

import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  attendanceEvents,
  branches,
  products,
  sales,
  tasks,
  tenants,
} from "@/lib/db/schema";

export interface DigestPayload {
  branchId: string;
  branchName: string;
  businessDate: string;
  sales: {
    gross: string;
    count: number;
    deltaPctVsSameWeekday: number | null;
    byMethod: {
      cash: string;
      card: string;
      instapay: string;
      deferred: string;
    };
  };
  topSku: { name: string; qty: number; revenue: string } | null;
  lowStock: {
    totalCount: number;
    top: { name: string; quantityLeft: number }[];
  };
  deferredOverdue: { count: number; totalOutstanding: string };
  attendanceReviewCount: number;
  unreadTaskCount: number;
}

/** Compute the digest payload for one (tenant, branch, business_date). */
export async function computeDigest(
  tenantId: string,
  branchId: string,
  businessDate: string,
): Promise<DigestPayload> {
  return withTenant(tenantId, async (tx) => {
    // Pull tenant timezone for the day-boundary math.
    const [tenant] = await tx
      .select({ tz: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const tz = tenant?.tz ?? "Africa/Cairo";

    const [branch] = await tx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.tenantId, tenantId), eq(branches.id, branchId)))
      .limit(1);
    if (!branch) {
      throw new Error(`branch ${branchId} not found`);
    }

    // [day_start, day_end) as UTC instants computed via Postgres tz math.
    // We can't easily mix string + timestamptz operands in Drizzle's where,
    // so we resolve the bounds first and feed them in as Date objects.
    const boundaryRows = (await tx.execute(sql`
      select
        ((${businessDate}::date)::timestamp at time zone ${tz})::timestamptz as day_start,
        (((${businessDate}::date + interval '1 day'))::timestamp at time zone ${tz})::timestamptz as day_end,
        (((${businessDate}::date - interval '7 days'))::timestamp at time zone ${tz})::timestamptz as last_week_start,
        (((${businessDate}::date - interval '6 days'))::timestamp at time zone ${tz})::timestamptz as last_week_end
    `)) as unknown as
      | { day_start: string; day_end: string; last_week_start: string; last_week_end: string }[]
      | {
          rows: {
            day_start: string;
            day_end: string;
            last_week_start: string;
            last_week_end: string;
          }[];
        };
    const boundaries = Array.isArray(boundaryRows)
      ? boundaryRows[0]
      : boundaryRows?.rows?.[0];
    if (!boundaries) throw new Error("could not resolve day boundaries");
    const dayStart = new Date(boundaries.day_start);
    const dayEnd = new Date(boundaries.day_end);
    const lastWeekStart = new Date(boundaries.last_week_start);
    const lastWeekEnd = new Date(boundaries.last_week_end);

    // ── Sales today ─────────────────────────────────────────────────────
    const [salesAgg] = await tx
      .select({
        gross: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
        count: sql<number>`coalesce(count(*), 0)::int`,
        cash: sql<string>`coalesce(sum(${sales.totalPrice}::numeric) filter (where ${sales.paymentMethod} = 'cash'), 0)::text`,
        card: sql<string>`coalesce(sum(${sales.totalPrice}::numeric) filter (where ${sales.paymentMethod} = 'card'), 0)::text`,
        instapay: sql<string>`coalesce(sum(${sales.totalPrice}::numeric) filter (where ${sales.paymentMethod} = 'instapay'), 0)::text`,
        deferred: sql<string>`coalesce(sum(${sales.totalPrice}::numeric) filter (where ${sales.paymentMethod} = 'deferred'), 0)::text`,
      })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, tenantId),
          eq(sales.branchId, branchId),
          gte(sales.saleDate, dayStart),
          lte(sales.saleDate, dayEnd),
        ),
      );

    // Same weekday last week (for the delta arrow).
    const [lastWeekAgg] = await tx
      .select({
        gross: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
      })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, tenantId),
          eq(sales.branchId, branchId),
          gte(sales.saleDate, lastWeekStart),
          lte(sales.saleDate, lastWeekEnd),
        ),
      );
    const todayGrossN = Number(salesAgg.gross);
    const lastWeekGrossN = Number(lastWeekAgg.gross);
    const deltaPctVsSameWeekday =
      lastWeekGrossN > 0
        ? Math.round(((todayGrossN - lastWeekGrossN) / lastWeekGrossN) * 100)
        : null;

    // ── Top SKU ─────────────────────────────────────────────────────────
    const [top] = await tx
      .select({
        name: sales.productName,
        qty: sql<number>`coalesce(sum(${sales.quantitySold}), 0)::int`,
        revenue: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
      })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, tenantId),
          eq(sales.branchId, branchId),
          gte(sales.saleDate, dayStart),
          lte(sales.saleDate, dayEnd),
        ),
      )
      .groupBy(sales.productName)
      .orderBy(sql`sum(${sales.totalPrice}::numeric) desc`)
      .limit(1);

    // ── Low stock ───────────────────────────────────────────────────────
    const lowStockRows = await tx
      .select({
        name: products.name,
        qty: products.quantity,
      })
      .from(products)
      .where(
        and(
          eq(products.tenantId, tenantId),
          eq(products.branchId, branchId),
          sql`${products.quantity} <= ${products.lowStockThreshold}`,
        ),
      )
      .orderBy(sql`${products.quantity} asc`);
    const lowStockTop = lowStockRows.slice(0, 3).map((r) => ({
      name: r.name,
      quantityLeft: r.qty,
    }));

    // ── Deferred ageing (> 7 days old, unpaid) ──────────────────────────
    const sevenDaysAgo = new Date(dayEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
    const [deferredAgg] = await tx
      .select({
        count: sql<number>`coalesce(count(*), 0)::int`,
        outstanding: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
      })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, tenantId),
          eq(sales.branchId, branchId),
          eq(sales.paymentMethod, "deferred"),
          eq(sales.isPaid, false),
          lte(sales.saleDate, sevenDaysAgo),
        ),
      );

    // ── Attendance review flags created today ───────────────────────────
    const [attendanceAgg] = await tx
      .select({ count: sql<number>`coalesce(count(*), 0)::int` })
      .from(attendanceEvents)
      .where(
        and(
          eq(attendanceEvents.tenantId, tenantId),
          eq(attendanceEvents.branchId, branchId),
          eq(attendanceEvents.requiresReview, true),
          gte(attendanceEvents.occurredAt, dayStart),
          lte(attendanceEvents.occurredAt, dayEnd),
        ),
      );

    // ── Unread tasks (assigned, unseen, open/in-progress) ───────────────
    const [taskAgg] = await tx
      .select({ count: sql<number>`coalesce(count(*), 0)::int` })
      .from(tasks)
      .where(
        and(
          eq(tasks.tenantId, tenantId),
          eq(tasks.branchId, branchId),
          isNull(tasks.assigneeSeenAt),
          or(eq(tasks.status, "open"), eq(tasks.status, "in_progress"))!,
        ),
      );

    return {
      branchId,
      branchName: branch.name,
      businessDate,
      sales: {
        gross: salesAgg.gross,
        count: salesAgg.count,
        deltaPctVsSameWeekday,
        byMethod: {
          cash: salesAgg.cash,
          card: salesAgg.card,
          instapay: salesAgg.instapay,
          deferred: salesAgg.deferred,
        },
      },
      topSku: top ? { name: top.name, qty: top.qty, revenue: top.revenue } : null,
      lowStock: { totalCount: lowStockRows.length, top: lowStockTop },
      deferredOverdue: {
        count: deferredAgg.count,
        totalOutstanding: deferredAgg.outstanding,
      },
      attendanceReviewCount: attendanceAgg.count,
      unreadTaskCount: taskAgg.count,
    };
  });
}

/** Drives the "send_on_empty=false → skip" path. */
export function isDigestEmpty(p: DigestPayload): boolean {
  return (
    p.sales.count === 0 &&
    p.lowStock.totalCount === 0 &&
    p.deferredOverdue.count === 0 &&
    p.attendanceReviewCount === 0 &&
    p.unreadTaskCount === 0
  );
}
