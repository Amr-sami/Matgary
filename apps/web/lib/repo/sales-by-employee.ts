import { and, eq, gte, isNotNull, lte, sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { sales, tenantMembers, users } from "@/lib/db/schema";

/**
 * Per-cashier sales roll-up for a window. The join to tenant_members +
 * users is left-outer so a row for a user who is no longer on the tenant
 * still comes back with the user id (and a null name) — a safer default than
 * dropping them.
 *
 * Added for the AI agent's `get_sales_by_employee` tool (apps/web/lib/ai/
 * tools/employees.ts). Not generic enough to belong next to the dashboard
 * roll-ups, which fan out across many reports; kept as its own repo file so
 * future HR features (payroll bonus by sales, etc.) have one place to extend.
 */

export interface SalesByEmployeeRow {
  recordedByUserId: string;
  employeeName: string | null;
  revenue: number;
  transactions: number;
  /** revenue / transactions, 0 when transactions is 0. */
  aov: number;
}

export async function loadSalesByEmployee(
  tenantId: string,
  args: {
    branchId?: string | null;
    from: Date;
    to: Date;
  },
): Promise<SalesByEmployeeRow[]> {
  return withTenant(tenantId, async (tx) => {
    const filters = [
      eq(sales.tenantId, tenantId),
      isNotNull(sales.recordedByUserId),
      gte(sales.saleDate, args.from),
      lte(sales.saleDate, args.to),
    ];
    if (args.branchId) filters.push(eq(sales.branchId, args.branchId));

    const rows = await tx
      .select({
        recordedByUserId: sales.recordedByUserId,
        employeeName: sql<
          string | null
        >`max(coalesce(${tenantMembers.displayName}, ${users.name}))`,
        revenue: sql<string>`coalesce(sum(${sales.totalPrice}), 0)::text`,
        transactions: sql<number>`count(*)::int`,
      })
      .from(sales)
      .leftJoin(
        tenantMembers,
        and(
          eq(tenantMembers.userId, sales.recordedByUserId),
          eq(tenantMembers.tenantId, tenantId),
        ),
      )
      .leftJoin(users, eq(users.id, sales.recordedByUserId))
      .where(and(...filters))
      .groupBy(sales.recordedByUserId);

    return rows
      .map((r) => {
        const revenue = Number(r.revenue ?? 0);
        const transactions = Number(r.transactions ?? 0);
        return {
          recordedByUserId: String(r.recordedByUserId),
          employeeName: r.employeeName ?? null,
          revenue,
          transactions,
          aov: transactions === 0 ? 0 : revenue / transactions,
        };
      })
      .sort((a, b) => b.revenue - a.revenue);
  });
}
