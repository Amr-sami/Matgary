// Platform-wide sales analytics. Everything runs through the BYPASSRLS pool
// so a single query aggregates across every tenant.
//
// Conventions:
//   - All monetary sums travel as strings (matches `sales.total_price`'s
//     text-typed numeric column — no JS float roundoff).
//   - Time buckets use `sale_date AT TIME ZONE tenants.timezone` so each
//     tenant's calendar boundaries are respected. Suspended tenants are
//     INCLUDED in historical totals (their past sales remain platform GMV)
//     but get a `suspended` badge on the list page.
//   - Returns/refunds are NOT subtracted — we report gross GMV, matching
//     the industry-default "total value sold" definition.

import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import {
  branches,
  sales,
  subscriptions,
  tenantMembers,
  tenants,
  users,
} from "@/lib/db/schema";
import { getAdminDb } from "./db";

export interface PlatformSalesKpi {
  gross: string;
  count: number;
}

export interface PlatformSalesOverview {
  today: PlatformSalesKpi;
  thisMonth: PlatformSalesKpi;
  thisYear: PlatformSalesKpi;
  deltas: {
    /** % delta of today vs same weekday last week. null = no comparable day. */
    todayWoW: number | null;
    /** % delta of this month vs last month (calendar). */
    thisMonthMoM: number | null;
    /** % delta of YTD vs same window last year. */
    thisYearYoY: number | null;
  };
  /** 12 months of platform gross GMV, oldest → newest. */
  series12mo: { month: string; gross: string; count: number }[];
  /** Top 5 stores by current-month gross GMV. */
  topStoresThisMonth: {
    tenantId: string;
    name: string;
    gross: string;
    count: number;
    plan: string | null;
  }[];
}

export type SalesRange =
  | "this_month"
  | "last_month"
  | "this_year"
  | "last_30d"
  | "last_90d";

export interface TenantSalesRow {
  tenantId: string;
  name: string;
  slug: string;
  plan: string | null;
  subscriptionStatus: string | null;
  suspended: boolean;
  gross: string;
  count: number;
  avgTicket: string;
  /** MoM = comparison to the same-length window immediately before. */
  momPct: number | null;
  ownerEmail: string | null;
}

export interface TenantSalesFilters {
  range: SalesRange;
  plan?: string;
  status?: "active" | "trialing" | "paying" | "suspended";
  limit?: number;
}

export interface TenantSalesPerformance {
  ytd: { gross: string; count: number };
  yoyPct: number | null;
  thisMonth: { gross: string; count: number };
  series12mo: { month: string; gross: string; count: number }[];
  topBranches: { branchId: string; name: string; gross: string; count: number }[];
  topProducts: { productName: string; gross: string; qty: number }[];
  paymentMix: {
    cash: string;
    card: string;
    instapay: string;
    deferred: string;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** SQL fragment that returns the tenant-local calendar start of *today*
 *  as a UTC instant. Used as the lower bound on `sale_date` to compute
 *  today's totals against each tenant's own clock. */
const todayLocal = sql`(date_trunc('day', now() AT TIME ZONE ${tenants.timezone}) AT TIME ZONE ${tenants.timezone})`;
const monthStartLocal = sql`(date_trunc('month', now() AT TIME ZONE ${tenants.timezone}) AT TIME ZONE ${tenants.timezone})`;
const yearStartLocal = sql`(date_trunc('year', now() AT TIME ZONE ${tenants.timezone}) AT TIME ZONE ${tenants.timezone})`;
const lastMonthStartLocal = sql`((date_trunc('month', now() AT TIME ZONE ${tenants.timezone}) - interval '1 month') AT TIME ZONE ${tenants.timezone})`;
const lastYearStartLocal = sql`((date_trunc('year', now() AT TIME ZONE ${tenants.timezone}) - interval '1 year') AT TIME ZONE ${tenants.timezone})`;
const lastWeekTodayLocal = sql`((date_trunc('day', now() AT TIME ZONE ${tenants.timezone}) - interval '7 days') AT TIME ZONE ${tenants.timezone})`;
const lastWeekTomorrowLocal = sql`((date_trunc('day', now() AT TIME ZONE ${tenants.timezone}) - interval '6 days') AT TIME ZONE ${tenants.timezone})`;

function pctChange(curr: string, prev: string): number | null {
  const c = Number(curr);
  const p = Number(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p <= 0) return null;
  return Math.round(((c - p) / p) * 100);
}

async function resolveOwnerEmails(
  tenantIds: string[],
): Promise<Map<string, string | null>> {
  const db = getAdminDb();
  const map = new Map<string, string | null>();
  if (tenantIds.length === 0) return map;
  const rows = await db
    .select({
      tenantId: tenantMembers.tenantId,
      email: users.email,
      joinedAt: tenantMembers.joinedAt,
    })
    .from(tenantMembers)
    .innerJoin(users, eq(users.id, tenantMembers.userId))
    .where(
      and(
        eq(tenantMembers.role, "owner"),
        inArray(tenantMembers.tenantId, tenantIds),
      ),
    );
  // Earliest joined wins.
  rows.sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
  for (const r of rows) {
    if (!map.has(r.tenantId)) map.set(r.tenantId, r.email);
  }
  return map;
}

// ─── Platform overview ───────────────────────────────────────────────────

export async function getPlatformSalesOverview(): Promise<PlatformSalesOverview> {
  const db = getAdminDb();

  // Window aggregates: today / month / year + their YoY/MoM/WoW baselines.
  // One big SQL block keyed against tenants.timezone so each store's
  // calendar boundaries apply to its own rows.
  const [
    todayAgg,
    lastWeekTodayAgg,
    monthAgg,
    lastMonthAgg,
    yearAgg,
    lastYearYtdAgg,
  ] = await Promise.all([
    db
      .select({
        gross: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
        count: sql<number>`coalesce(count(*), 0)::int`,
      })
      .from(sales)
      .innerJoin(tenants, eq(tenants.id, sales.tenantId))
      .where(sql`${sales.saleDate} >= ${todayLocal}`),
    db
      .select({
        gross: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
      })
      .from(sales)
      .innerJoin(tenants, eq(tenants.id, sales.tenantId))
      .where(
        and(
          sql`${sales.saleDate} >= ${lastWeekTodayLocal}`,
          sql`${sales.saleDate} < ${lastWeekTomorrowLocal}`,
        ),
      ),
    db
      .select({
        gross: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
        count: sql<number>`coalesce(count(*), 0)::int`,
      })
      .from(sales)
      .innerJoin(tenants, eq(tenants.id, sales.tenantId))
      .where(sql`${sales.saleDate} >= ${monthStartLocal}`),
    db
      .select({
        gross: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
      })
      .from(sales)
      .innerJoin(tenants, eq(tenants.id, sales.tenantId))
      .where(
        and(
          sql`${sales.saleDate} >= ${lastMonthStartLocal}`,
          sql`${sales.saleDate} < ${monthStartLocal}`,
        ),
      ),
    db
      .select({
        gross: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
        count: sql<number>`coalesce(count(*), 0)::int`,
      })
      .from(sales)
      .innerJoin(tenants, eq(tenants.id, sales.tenantId))
      .where(sql`${sales.saleDate} >= ${yearStartLocal}`),
    // Same window into last year — bounded by today's day-of-year to keep
    // comparable.
    db
      .select({
        gross: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
      })
      .from(sales)
      .innerJoin(tenants, eq(tenants.id, sales.tenantId))
      .where(
        and(
          sql`${sales.saleDate} >= ${lastYearStartLocal}`,
          sql`${sales.saleDate} < (now() - interval '1 year')`,
        ),
      ),
  ]);

  // 12-month series. We bucket by the platform's primary timezone for the
  // chart axis — using each tenant's tz would put the same calendar month
  // in different buckets for different stores, which makes the chart
  // visually confusing.
  const seriesRows = await db.execute(sql`
    select
      to_char(date_trunc('month', s.sale_date AT TIME ZONE 'Africa/Cairo'), 'YYYY-MM') as month,
      coalesce(sum(s.total_price::numeric), 0)::text as gross,
      coalesce(count(*), 0)::int as count
    from sales s
    where s.sale_date >= (date_trunc('month', now() AT TIME ZONE 'Africa/Cairo') - interval '11 months') AT TIME ZONE 'Africa/Cairo'
    group by 1
    order by 1
  `);
  const seriesArr = (
    Array.isArray(seriesRows)
      ? seriesRows
      : (seriesRows as { rows?: unknown[] }).rows
  ) as { month: string; gross: string; count: number }[] | undefined;
  const series12mo = fillMonths(seriesArr ?? [], 12);

  // Top stores by current-month gross.
  const topRows = await db
    .select({
      tenantId: sales.tenantId,
      name: tenants.name,
      plan: subscriptions.plan,
      gross: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
      count: sql<number>`coalesce(count(*), 0)::int`,
    })
    .from(sales)
    .innerJoin(tenants, eq(tenants.id, sales.tenantId))
    .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
    .where(sql`${sales.saleDate} >= ${monthStartLocal}`)
    .groupBy(sales.tenantId, tenants.name, subscriptions.plan)
    .orderBy(desc(sql`sum(${sales.totalPrice}::numeric)`))
    .limit(5);

  return {
    today: {
      gross: todayAgg[0]?.gross ?? "0",
      count: todayAgg[0]?.count ?? 0,
    },
    thisMonth: {
      gross: monthAgg[0]?.gross ?? "0",
      count: monthAgg[0]?.count ?? 0,
    },
    thisYear: {
      gross: yearAgg[0]?.gross ?? "0",
      count: yearAgg[0]?.count ?? 0,
    },
    deltas: {
      todayWoW: pctChange(
        todayAgg[0]?.gross ?? "0",
        lastWeekTodayAgg[0]?.gross ?? "0",
      ),
      thisMonthMoM: pctChange(
        monthAgg[0]?.gross ?? "0",
        lastMonthAgg[0]?.gross ?? "0",
      ),
      thisYearYoY: pctChange(
        yearAgg[0]?.gross ?? "0",
        lastYearYtdAgg[0]?.gross ?? "0",
      ),
    },
    series12mo,
    topStoresThisMonth: topRows.map((r) => ({
      tenantId: r.tenantId,
      name: r.name,
      gross: r.gross,
      count: r.count,
      plan: r.plan ?? null,
    })),
  };
}

// ─── Cross-tenant table ──────────────────────────────────────────────────

function rangeBounds(
  range: SalesRange,
): {
  current: { start: ReturnType<typeof sql>; end: ReturnType<typeof sql> };
  prev: { start: ReturnType<typeof sql>; end: ReturnType<typeof sql> };
} {
  const nowLocal = sql`(now() AT TIME ZONE ${tenants.timezone})`;
  const tz = tenants.timezone;
  switch (range) {
    case "this_month":
      return {
        current: { start: monthStartLocal, end: nowLocal },
        prev: {
          start: lastMonthStartLocal,
          end: monthStartLocal,
        },
      };
    case "last_month":
      return {
        current: {
          start: lastMonthStartLocal,
          end: monthStartLocal,
        },
        prev: {
          start: sql`((date_trunc('month', now() AT TIME ZONE ${tz}) - interval '2 months') AT TIME ZONE ${tz})`,
          end: lastMonthStartLocal,
        },
      };
    case "this_year":
      return {
        current: { start: yearStartLocal, end: nowLocal },
        prev: { start: lastYearStartLocal, end: yearStartLocal },
      };
    case "last_30d":
      return {
        current: {
          start: sql`(now() - interval '30 days')`,
          end: nowLocal,
        },
        prev: {
          start: sql`(now() - interval '60 days')`,
          end: sql`(now() - interval '30 days')`,
        },
      };
    case "last_90d":
      return {
        current: {
          start: sql`(now() - interval '90 days')`,
          end: nowLocal,
        },
        prev: {
          start: sql`(now() - interval '180 days')`,
          end: sql`(now() - interval '90 days')`,
        },
      };
  }
}

export async function listTenantSales(
  filters: TenantSalesFilters,
): Promise<TenantSalesRow[]> {
  const db = getAdminDb();
  const { current, prev } = rangeBounds(filters.range);

  // Use one SQL with two filter aggregates so a single scan computes both
  // windows. The aggregate is bounded by the tenant's local timezone, so
  // each row is fairly compared against its own calendar.
  const rows = await db
    .select({
      tenantId: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      plan: subscriptions.plan,
      subscriptionStatus: subscriptions.status,
      suspendedAt: tenants.suspendedAt,
      gross: sql<string>`coalesce(sum(${sales.totalPrice}::numeric) filter (where ${sales.saleDate} >= ${current.start} and ${sales.saleDate} < ${current.end}), 0)::text`,
      count: sql<number>`coalesce(count(*) filter (where ${sales.saleDate} >= ${current.start} and ${sales.saleDate} < ${current.end}), 0)::int`,
      prevGross: sql<string>`coalesce(sum(${sales.totalPrice}::numeric) filter (where ${sales.saleDate} >= ${prev.start} and ${sales.saleDate} < ${prev.end}), 0)::text`,
    })
    .from(tenants)
    .leftJoin(sales, eq(sales.tenantId, tenants.id))
    .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
    .groupBy(tenants.id, tenants.name, tenants.slug, subscriptions.plan, subscriptions.status, tenants.suspendedAt);

  // Resolve owner emails up-front in one round-trip.
  const tenantIds = rows.map((r) => r.tenantId);
  const ownerMap = await resolveOwnerEmails(tenantIds);

  let projected: TenantSalesRow[] = rows.map((r) => {
    const count = r.count;
    const grossN = Number(r.gross);
    return {
      tenantId: r.tenantId,
      name: r.name,
      slug: r.slug,
      plan: r.plan ?? null,
      subscriptionStatus: r.subscriptionStatus ?? null,
      suspended: !!r.suspendedAt,
      gross: r.gross,
      count,
      avgTicket: count > 0 ? (grossN / count).toFixed(2) : "0",
      momPct: pctChange(r.gross, r.prevGross),
      ownerEmail: ownerMap.get(r.tenantId) ?? null,
    };
  });

  // Apply plan + status filters in-memory — the table is bounded by tenant
  // count, not row count.
  if (filters.plan) {
    projected = projected.filter((r) => r.plan === filters.plan);
  }
  if (filters.status) {
    if (filters.status === "suspended") {
      projected = projected.filter((r) => r.suspended);
    } else if (filters.status === "paying") {
      projected = projected.filter(
        (r) => r.subscriptionStatus === "active" && !r.suspended,
      );
    } else if (filters.status === "active") {
      projected = projected.filter(
        (r) => r.subscriptionStatus === "active" && !r.suspended,
      );
    } else if (filters.status === "trialing") {
      projected = projected.filter(
        (r) => r.subscriptionStatus === "trialing" && !r.suspended,
      );
    }
  }

  projected.sort((a, b) => Number(b.gross) - Number(a.gross));
  if (filters.limit) projected = projected.slice(0, filters.limit);
  return projected;
}

// ─── Per-tenant drill-down ───────────────────────────────────────────────

export async function getTenantSalesPerformance(
  tenantId: string,
): Promise<TenantSalesPerformance> {
  const db = getAdminDb();

  const [tenant] = await db
    .select({ id: tenants.id, tz: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) {
    return {
      ytd: { gross: "0", count: 0 },
      yoyPct: null,
      thisMonth: { gross: "0", count: 0 },
      series12mo: fillMonths([], 12),
      topBranches: [],
      topProducts: [],
      paymentMix: { cash: "0", card: "0", instapay: "0", deferred: "0" },
    };
  }
  const tz = tenant.tz ?? "Africa/Cairo";

  // 12-month series for this tenant.
  const seriesRows = await db.execute(sql`
    select
      to_char(date_trunc('month', sale_date AT TIME ZONE ${tz}), 'YYYY-MM') as month,
      coalesce(sum(total_price::numeric), 0)::text as gross,
      coalesce(count(*), 0)::int as count
    from sales
    where tenant_id = ${tenantId}
      and sale_date >= (date_trunc('month', now() AT TIME ZONE ${tz}) - interval '11 months') AT TIME ZONE ${tz}
    group by 1
    order by 1
  `);
  const seriesArr = (
    Array.isArray(seriesRows)
      ? seriesRows
      : (seriesRows as { rows?: unknown[] }).rows
  ) as { month: string; gross: string; count: number }[] | undefined;
  const series12mo = fillMonths(seriesArr ?? [], 12);

  // YTD + YoY + MTD.
  const [ytdAgg, ytdLastYearAgg, monthAgg] = await Promise.all([
    db.execute(sql`
      select
        coalesce(sum(total_price::numeric), 0)::text as gross,
        coalesce(count(*), 0)::int as count
      from sales
      where tenant_id = ${tenantId}
        and sale_date >= (date_trunc('year', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})
    `),
    db.execute(sql`
      select coalesce(sum(total_price::numeric), 0)::text as gross
      from sales
      where tenant_id = ${tenantId}
        and sale_date >= ((date_trunc('year', now() AT TIME ZONE ${tz}) - interval '1 year') AT TIME ZONE ${tz})
        and sale_date < (now() - interval '1 year')
    `),
    db.execute(sql`
      select
        coalesce(sum(total_price::numeric), 0)::text as gross,
        coalesce(count(*), 0)::int as count
      from sales
      where tenant_id = ${tenantId}
        and sale_date >= (date_trunc('month', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})
    `),
  ]);

  const pickRow = <T>(r: unknown): T | null => {
    const arr = (Array.isArray(r) ? r : (r as { rows?: T[] }).rows) as
      | T[]
      | undefined;
    return arr?.[0] ?? null;
  };
  const ytd =
    pickRow<{ gross: string; count: number }>(ytdAgg) ?? { gross: "0", count: 0 };
  const ytdLastYear =
    pickRow<{ gross: string }>(ytdLastYearAgg) ?? { gross: "0" };
  const month =
    pickRow<{ gross: string; count: number }>(monthAgg) ?? {
      gross: "0",
      count: 0,
    };

  // Top branches this month.
  const topBranchRows = await db
    .select({
      branchId: sales.branchId,
      name: branches.name,
      gross: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
      count: sql<number>`coalesce(count(*), 0)::int`,
    })
    .from(sales)
    .innerJoin(branches, eq(branches.id, sales.branchId))
    .where(
      and(
        eq(sales.tenantId, tenantId),
        sql`${sales.saleDate} >= (date_trunc('month', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`,
      ),
    )
    .groupBy(sales.branchId, branches.name)
    .orderBy(desc(sql`sum(${sales.totalPrice}::numeric)`))
    .limit(3);

  // Top products this month.
  const topProductRows = await db
    .select({
      productName: sales.productName,
      gross: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
      qty: sql<number>`coalesce(sum(${sales.quantitySold}), 0)::int`,
    })
    .from(sales)
    .where(
      and(
        eq(sales.tenantId, tenantId),
        sql`${sales.saleDate} >= (date_trunc('month', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`,
      ),
    )
    .groupBy(sales.productName)
    .orderBy(desc(sql`sum(${sales.totalPrice}::numeric)`))
    .limit(5);

  // Payment-method mix this month.
  const [paymentAgg] = await db
    .select({
      cash: sql<string>`coalesce(sum(${sales.totalPrice}::numeric) filter (where ${sales.paymentMethod} = 'cash'), 0)::text`,
      card: sql<string>`coalesce(sum(${sales.totalPrice}::numeric) filter (where ${sales.paymentMethod} = 'card'), 0)::text`,
      instapay: sql<string>`coalesce(sum(${sales.totalPrice}::numeric) filter (where ${sales.paymentMethod} = 'instapay'), 0)::text`,
      deferred: sql<string>`coalesce(sum(${sales.totalPrice}::numeric) filter (where ${sales.paymentMethod} = 'deferred'), 0)::text`,
    })
    .from(sales)
    .where(
      and(
        eq(sales.tenantId, tenantId),
        sql`${sales.saleDate} >= (date_trunc('month', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`,
      ),
    );

  return {
    ytd,
    yoyPct: pctChange(ytd.gross, ytdLastYear.gross),
    thisMonth: month,
    series12mo,
    topBranches: topBranchRows
      .filter((r): r is { branchId: string; name: string; gross: string; count: number } => !!r.branchId)
      .map((r) => ({
        branchId: r.branchId,
        name: r.name,
        gross: r.gross,
        count: r.count,
      })),
    topProducts: topProductRows.map((r) => ({
      productName: r.productName,
      gross: r.gross,
      qty: r.qty,
    })),
    paymentMix: paymentAgg ?? { cash: "0", card: "0", instapay: "0", deferred: "0" },
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────

/** Pad the series so every chart shows exactly N months, even when some
 *  are empty. The buckets are produced in the same `YYYY-MM` format the
 *  SQL `to_char` uses so the merge is a straight lookup. */
function fillMonths(
  rows: { month: string; gross: string; count: number }[],
  windowMonths: number,
): { month: string; gross: string; count: number }[] {
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const out: { month: string; gross: string; count: number }[] = [];
  const cursor = new Date();
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  for (let i = windowMonths - 1; i >= 0; i -= 1) {
    const d = new Date(cursor);
    d.setUTCMonth(d.getUTCMonth() - i);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    out.push(byMonth.get(month) ?? { month, gross: "0", count: 0 });
  }
  return out;
}

// Silence unused-locals warnings for helpers exposed but only conditionally
// reached above.
void gt;
void lte;
