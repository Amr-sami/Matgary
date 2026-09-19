import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { requirePermission } from "@/lib/api/auth-helpers";
import { withTenant } from "@/lib/db";
import { sales, returns, users, tenantMembers } from "@/lib/db/schema";

interface StaffStat {
  userId: string;
  name: string;
  salesCount: number;
  salesRevenue: number;
  returnsCount: number;
}

export async function GET(req: NextRequest) {
  const r = await requirePermission("view_insights");
  if (!r.ok) return r.response;

  // Default range: last 30 days.
  const now = new Date();
  const startParam = req.nextUrl.searchParams.get("from");
  const endParam = req.nextUrl.searchParams.get("to");
  const start = startParam
    ? new Date(startParam)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const end = endParam ? new Date(endParam) : now;

  const data = await withTenant(r.ctx.tenantId, async (tx) => {
    // Aggregate sales by recorded_by_user_id within the window.
    const saleRows = await tx
      .select({
        userId: sales.recordedByUserId,
        count: sql<number>`count(*)::int`,
        revenue: sql<string>`coalesce(sum((${sales.totalPrice})::numeric), 0)::text`,
      })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, r.ctx.tenantId),
          eq(sales.isReturned, false),
          gte(sales.saleDate, start),
          lte(sales.saleDate, end),
        ),
      )
      .groupBy(sales.recordedByUserId);

    // Aggregate returns by the cashier of the underlying sale.
    const returnRows = await tx
      .select({
        userId: sales.recordedByUserId,
        count: sql<number>`count(*)::int`,
      })
      .from(returns)
      .innerJoin(sales, eq(sales.id, returns.saleId))
      .where(
        and(
          eq(returns.tenantId, r.ctx.tenantId),
          gte(returns.returnDate, start),
          lte(returns.returnDate, end),
        ),
      )
      .groupBy(sales.recordedByUserId);

    // Merge.
    const byId = new Map<string | null, StaffStat>();
    for (const s of saleRows) {
      byId.set(s.userId, {
        userId: s.userId ?? "__unattributed__",
        name: "",
        salesCount: s.count,
        salesRevenue: Number(s.revenue),
        returnsCount: 0,
      });
    }
    for (const rt of returnRows) {
      const existing = byId.get(rt.userId);
      if (existing) {
        existing.returnsCount = rt.count;
      } else {
        byId.set(rt.userId, {
          userId: rt.userId ?? "__unattributed__",
          name: "",
          salesCount: 0,
          salesRevenue: 0,
          returnsCount: rt.count,
        });
      }
    }

    // Resolve display names.
    const knownIds = Array.from(byId.keys()).filter(
      (v): v is string => !!v,
    );
    if (knownIds.length > 0) {
      const nameRows = await tx
        .select({
          userId: users.id,
          name: sql<string | null>`coalesce(${tenantMembers.displayName}, ${users.name})`,
        })
        .from(users)
        .leftJoin(
          tenantMembers,
          and(
            eq(tenantMembers.userId, users.id),
            eq(tenantMembers.tenantId, r.ctx.tenantId),
          ),
        )
        .where(inArray(users.id, knownIds));
      const map = new Map(nameRows.map((n) => [n.userId, n.name]));
      for (const stat of byId.values()) {
        if (stat.userId === "__unattributed__") {
          stat.name = "غير معروف";
        } else {
          stat.name = map.get(stat.userId) ?? "—";
        }
      }
    }

    return Array.from(byId.values()).sort((a, b) => b.salesRevenue - a.salesRevenue);
  });

  return NextResponse.json({
    data,
    range: { from: start.toISOString(), to: end.toISOString() },
  });
}
