import { and, desc, eq, gte, sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { purchaseOrders, suppliers } from "@/lib/db/schema";
import { getPurchaseOrder } from "@/lib/repo/purchase-orders";

import type { Tool } from "./types";
import { PERIOD_SCHEMA, parseLimit, parsePeriod, windowFor } from "./_shared";

/**
 * F10.4 — Purchase-order read tools.
 *
 * Period-scoped volume/payment roll-ups + full PO lookup. Status filters out
 * cancelled rows by default so totals reflect real spend.
 */

/* ──────────────────────── get_purchases_summary ────────────────────── */

export const getPurchasesSummary: Tool = {
  name: "get_purchases_summary",
  description:
    "Purchase-orders roll-up for a period: total ordered, total received, total paid, outstanding supplier debt, PO counts by status, top suppliers by volume. Use for 'how much did I purchase', 'outstanding PO debt', 'biggest buys'.",
  requiredPermission: "view_purchases",
  parameters: {
    type: "object",
    properties: {
      period: PERIOD_SCHEMA,
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 30,
        description: "Max top-supplier rows to return (default 10).",
      },
    },
    required: ["period"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const period = parsePeriod(args.period);
    const limit = parseLimit(args.limit, 10, 30);
    const w = windowFor(period);

    return withTenant(ctx.tenantId, async (tx) => {
      const filters = [eq(purchaseOrders.tenantId, ctx.tenantId)];
      if (w) filters.push(gte(purchaseOrders.orderDate, w.from));

      const [agg] = await tx
        .select({
          count: sql<number>`count(*)::int`,
          draftCount: sql<number>`sum(case when ${purchaseOrders.status} = 'draft' then 1 else 0 end)::int`,
          receivedCount: sql<number>`sum(case when ${purchaseOrders.status} = 'received' then 1 else 0 end)::int`,
          cancelledCount: sql<number>`sum(case when ${purchaseOrders.status} = 'cancelled' then 1 else 0 end)::int`,
          totalOrdered: sql<string>`coalesce(sum(case when ${purchaseOrders.status} != 'cancelled' then (${purchaseOrders.total})::numeric else 0 end), 0)::text`,
          totalReceived: sql<string>`coalesce(sum(case when ${purchaseOrders.status} = 'received' then (${purchaseOrders.total})::numeric else 0 end), 0)::text`,
          totalPaid: sql<string>`coalesce(sum(case when ${purchaseOrders.status} != 'cancelled' then (${purchaseOrders.paidAmount})::numeric else 0 end), 0)::text`,
        })
        .from(purchaseOrders)
        .where(and(...filters));

      const topSuppliers = await tx
        .select({
          supplierId: purchaseOrders.supplierId,
          name: sql<string>`max(${suppliers.name})`,
          poCount: sql<number>`count(*)::int`,
          volume: sql<string>`coalesce(sum(case when ${purchaseOrders.status} != 'cancelled' then (${purchaseOrders.total})::numeric else 0 end), 0)::text`,
          paid: sql<string>`coalesce(sum(case when ${purchaseOrders.status} != 'cancelled' then (${purchaseOrders.paidAmount})::numeric else 0 end), 0)::text`,
        })
        .from(purchaseOrders)
        .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
        .where(and(...filters))
        .groupBy(purchaseOrders.supplierId)
        .orderBy(
          sql`coalesce(sum(case when ${purchaseOrders.status} != 'cancelled' then (${purchaseOrders.total})::numeric else 0 end), 0) desc`,
        )
        .limit(limit);

      const totalOrdered = Number(agg?.totalOrdered ?? 0);
      const totalReceived = Number(agg?.totalReceived ?? 0);
      const totalPaid = Number(agg?.totalPaid ?? 0);

      return {
        ok: true,
        data: {
          period,
          currency: "EGP",
          window: w
            ? { from: w.from.toISOString(), to: w.to.toISOString() }
            : null,
          totals: {
            count: agg?.count ?? 0,
            draftCount: agg?.draftCount ?? 0,
            receivedCount: agg?.receivedCount ?? 0,
            cancelledCount: agg?.cancelledCount ?? 0,
            totalOrdered,
            totalReceived,
            totalPaid,
            outstanding: round2(totalReceived - totalPaid),
          },
          topSuppliers: topSuppliers.map((s) => ({
            supplierId: s.supplierId,
            name: s.name,
            poCount: Number(s.poCount ?? 0),
            volume: Number(s.volume ?? 0),
            paid: Number(s.paid ?? 0),
            balance: round2(Number(s.volume ?? 0) - Number(s.paid ?? 0)),
          })),
        },
      };
    });
  },
};

/* ────────────────────── get_purchase_order_details ─────────────────── */

export const getPurchaseOrderDetails: Tool = {
  name: "get_purchase_order_details",
  description:
    "Full detail for one purchase order: supplier, status, line items, totals, payments-to-date. Pass the exact PO id.",
  requiredPermission: "view_purchases",
  parameters: {
    type: "object",
    properties: {
      purchase_order_id: {
        type: "string",
        minLength: 10,
        description: "Exact PO id (uuid).",
      },
    },
    required: ["purchase_order_id"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const id = String(args.purchase_order_id ?? "").trim();
    if (!id) return { ok: false, error: "EMPTY_PO_ID" };
    const po = await getPurchaseOrder(ctx.tenantId, id);
    if (!po) return { ok: true, data: { found: false, purchaseOrderId: id } };
    return {
      ok: true,
      data: {
        found: true,
        currency: "EGP",
        id: po.id,
        supplierId: po.supplierId,
        supplierName: po.supplierName,
        status: po.status,
        orderDate: po.orderDate.toISOString(),
        receivedDate: po.receivedDate?.toISOString() ?? null,
        notes: po.notes,
        total: po.total,
        paidAmount: po.paidAmount,
        balance: round2(po.total - po.paidAmount),
        itemCount: po.itemCount,
        items: po.items.map((i) => ({
          id: i.id,
          productId: i.productId,
          productName: i.productName,
          quantity: i.quantity,
          unitCost: i.unitCost,
          lineTotal: i.lineTotal,
        })),
      },
    };
  },
};

/* ────────────────────────── get_recent_purchase_orders ─────────────── */

export const getRecentPurchaseOrders: Tool = {
  name: "get_recent_purchase_orders",
  description:
    "List the most recent purchase orders (any status) with supplier + totals. Use to answer 'what did I order lately', 'recent purchases'.",
  requiredPermission: "view_purchases",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 30 },
      status: {
        type: "string",
        enum: ["draft", "received", "cancelled"],
        description: "Optional status filter.",
      },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const limit = parseLimit(args.limit, 10, 30);
    const status =
      args.status === "draft" || args.status === "received" || args.status === "cancelled"
        ? args.status
        : null;
    return withTenant(ctx.tenantId, async (tx) => {
      const filters = [eq(purchaseOrders.tenantId, ctx.tenantId)];
      if (status) filters.push(eq(purchaseOrders.status, status));

      const rows = await tx
        .select({
          id: purchaseOrders.id,
          supplierId: purchaseOrders.supplierId,
          supplierName: suppliers.name,
          status: purchaseOrders.status,
          orderDate: purchaseOrders.orderDate,
          receivedDate: purchaseOrders.receivedDate,
          total: purchaseOrders.total,
          paidAmount: purchaseOrders.paidAmount,
        })
        .from(purchaseOrders)
        .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
        .where(and(...filters))
        .orderBy(desc(purchaseOrders.orderDate))
        .limit(limit);

      return {
        ok: true,
        data: {
          currency: "EGP",
          count: rows.length,
          purchaseOrders: rows.map((r) => ({
            id: r.id,
            supplierId: r.supplierId,
            supplierName: r.supplierName,
            status: r.status,
            orderDate: r.orderDate.toISOString(),
            receivedDate: r.receivedDate?.toISOString() ?? null,
            total: Number(r.total),
            paidAmount: Number(r.paidAmount),
            balance: round2(Number(r.total) - Number(r.paidAmount)),
          })),
        },
      };
    });
  },
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
