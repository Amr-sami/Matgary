import { and, desc, eq, gte, ilike, or, sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import {
  purchaseOrderPayments,
  purchaseOrders,
  suppliers,
} from "@/lib/db/schema";

import type { Tool } from "./types";
import {
  PERIOD_SCHEMA,
  parseBool,
  parseLimit,
  parsePeriod,
  windowFor,
} from "./_shared";

/**
 * F10.4 — Supplier read tools.
 *
 * Reads only. No tool here mutates supplier state; payments/POs ship through
 * their existing (non-AI) routes so the normal domain logic + fanout runs.
 *
 * The LLM never calculates a balance or a P&L figure — every number here is
 * server-aggregated. Keeps the "server calculates, LLM reasons" rule.
 *
 * Isolation: tenant_id only. Storo has no branch feature — the suppliers table
 * carries a legacy branch_id column populated by older code paths, but this
 * tool scopes purely by tenant.
 */

/* ──────────────────────────── resolve_supplier ─────────────────────── */

/**
 * resolve_supplier — tier-matched disambiguation, intended as the FIRST
 * step before preview_create_expense when the user names a supplier by
 * free-text. Mirrors resolve/products.ts semantics: HIGH → one exact match
 * (safe to use the id), MEDIUM → one close partial match, LOW → multiple
 * ambiguous, NONE → nothing found. The Agent must ask the user when the
 * tier isn't HIGH; it must NEVER invent a supplierId.
 */
export const resolveSupplier: Tool = {
  name: "resolve_supplier",
  description:
    "Resolve a free-text supplier reference to a tenant supplier id for use in preview_create_expense.supplierId. Returns tiered candidates: HIGH (one exact / unique match → safe to use the id), MEDIUM (one close but non-exact), LOW (multiple partial matches → ask the user), NONE (not found → do NOT invent). Tenant-scoped.",
  requiredPermission: "view_suppliers",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 2, description: "Supplier name fragment or phone." },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const q = String(args.query ?? "").trim();
    if (!q) return { ok: false, error: "EMPTY_QUERY" };
    const limit = parseLimit(args.limit, 5, 10);
    const qLower = q.toLowerCase();
    const pattern = `%${q}%`;
    return withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: suppliers.id,
          name: suppliers.name,
          phone: suppliers.phone,
        })
        .from(suppliers)
        .where(
          and(
            eq(suppliers.tenantId, ctx.tenantId),
            or(ilike(suppliers.name, pattern), ilike(suppliers.phone, pattern)),
          ),
        )
        .limit(limit * 2);

      const scored = rows.map((r) => {
        const name = (r.name ?? "").toLowerCase().trim();
        let score: number;
        if (name === qLower) score = 1.0;
        else if (name.startsWith(qLower)) score = 0.85;
        else if (name.split(/\s+/).some((p) => p === qLower)) score = 0.9;
        else score = 0.5;
        return { id: r.id, name: r.name, phone: r.phone, score };
      });
      scored.sort((a, b) => b.score - a.score);
      const topN = scored.slice(0, limit);
      let tier: "HIGH" | "MEDIUM" | "LOW" | "NONE";
      if (topN.length === 0) tier = "NONE";
      else if (
        topN[0]!.score >= 1 &&
        topN.filter((c) => c.score === topN[0]!.score).length === 1
      )
        tier = "HIGH";
      else if (topN.length === 1) tier = "MEDIUM";
      else tier = "LOW";
      return {
        ok: true,
        data: { query: q, tier, candidates: topN },
      };
    });
  },
};

/* ────────────────────────────── find_supplier ──────────────────────── */

export const findSupplier: Tool = {
  name: "find_supplier",
  description:
    "Look up suppliers by partial name or phone (case-insensitive). Returns up to 10 candidates with their running balance so the user can pick one. For deeper detail (recent POs, payments) call get_supplier_details with the chosen id.",
  requiredPermission: "view_suppliers",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 2,
        description: "Partial supplier name or phone fragment.",
      },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const q = String(args.query ?? "").trim();
    if (!q) return { ok: false, error: "EMPTY_QUERY" };
    const limit = parseLimit(args.limit, 10, 20);
    const pattern = `%${q}%`;
    return withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: suppliers.id,
          name: suppliers.name,
          phone: suppliers.phone,
          email: suppliers.email,
          balance: suppliers.balance,
        })
        .from(suppliers)
        .where(
          and(
            eq(suppliers.tenantId, ctx.tenantId),
            or(
              ilike(suppliers.name, pattern),
              ilike(suppliers.phone, pattern),
            ),
          ),
        )
        .limit(limit);
      return {
        ok: true,
        data: {
          query: q,
          currency: "EGP",
          count: rows.length,
          suppliers: rows.map((r) => ({
            id: r.id,
            name: r.name,
            phone: r.phone,
            email: r.email,
            // Positive balance = we owe the supplier that much.
            outstandingBalance: Number(r.balance ?? 0),
          })),
        },
      };
    });
  },
};

/* ──────────────────────── get_supplier_details ─────────────────────── */

export const getSupplierDetails: Tool = {
  name: "get_supplier_details",
  description:
    "Full ledger for one supplier: outstanding balance, total PO volume + count, total paid, recent POs, recent payments. Pass an exact supplier id (ideally one returned by find_supplier).",
  requiredPermission: "view_suppliers",
  parameters: {
    type: "object",
    properties: {
      supplier_id: {
        type: "string",
        minLength: 10,
        description: "Exact supplier id (uuid) as returned by find_supplier.",
      },
    },
    required: ["supplier_id"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const supplierId = String(args.supplier_id ?? "").trim();
    if (!supplierId) return { ok: false, error: "EMPTY_SUPPLIER_ID" };
    return withTenant(ctx.tenantId, async (tx) => {
      const [sup] = await tx
        .select()
        .from(suppliers)
        .where(
          and(eq(suppliers.tenantId, ctx.tenantId), eq(suppliers.id, supplierId)),
        )
        .limit(1);
      if (!sup) {
        return { ok: true, data: { found: false, supplierId } };
      }

      const [totals] = await tx
        .select({
          poCount: sql<number>`count(*)::int`,
          poVolume: sql<string>`coalesce(sum(${purchaseOrders.total}), 0)::text`,
          poPaid: sql<string>`coalesce(sum(${purchaseOrders.paidAmount}), 0)::text`,
          receivedCount: sql<number>`sum(case when ${purchaseOrders.status} = 'received' then 1 else 0 end)::int`,
          draftCount: sql<number>`sum(case when ${purchaseOrders.status} = 'draft' then 1 else 0 end)::int`,
        })
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.tenantId, ctx.tenantId),
            eq(purchaseOrders.supplierId, supplierId),
          ),
        );

      const recentPos = await tx
        .select({
          id: purchaseOrders.id,
          status: purchaseOrders.status,
          orderDate: purchaseOrders.orderDate,
          receivedDate: purchaseOrders.receivedDate,
          total: purchaseOrders.total,
          paidAmount: purchaseOrders.paidAmount,
        })
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.tenantId, ctx.tenantId),
            eq(purchaseOrders.supplierId, supplierId),
          ),
        )
        .orderBy(desc(purchaseOrders.orderDate))
        .limit(8);

      const recentPayments = await tx
        .select({
          id: purchaseOrderPayments.id,
          purchaseOrderId: purchaseOrderPayments.purchaseOrderId,
          amount: purchaseOrderPayments.amount,
          method: purchaseOrderPayments.method,
          paidAt: purchaseOrderPayments.paidAt,
        })
        .from(purchaseOrderPayments)
        .where(
          and(
            eq(purchaseOrderPayments.tenantId, ctx.tenantId),
            eq(purchaseOrderPayments.supplierId, supplierId),
          ),
        )
        .orderBy(desc(purchaseOrderPayments.paidAt))
        .limit(8);

      return {
        ok: true,
        data: {
          found: true,
          supplierId,
          name: sup.name,
          phone: sup.phone,
          email: sup.email,
          address: sup.address,
          currency: "EGP",
          outstandingBalance: Number(sup.balance ?? 0),
          poCount: totals?.poCount ?? 0,
          poReceivedCount: totals?.receivedCount ?? 0,
          poDraftCount: totals?.draftCount ?? 0,
          lifetimePoVolume: Number(totals?.poVolume ?? 0),
          lifetimePaid: Number(totals?.poPaid ?? 0),
          recentPurchaseOrders: recentPos.map((r) => ({
            id: r.id,
            status: r.status,
            orderDate: r.orderDate.toISOString(),
            receivedDate: r.receivedDate?.toISOString() ?? null,
            total: Number(r.total),
            paidAmount: Number(r.paidAmount),
            balance: Number(r.total) - Number(r.paidAmount),
          })),
          recentPayments: recentPayments.map((p) => ({
            id: p.id,
            purchaseOrderId: p.purchaseOrderId,
            amount: Number(p.amount),
            method: p.method,
            paidAt: p.paidAt.toISOString(),
          })),
        },
      };
    });
  },
};

/* ───────────────────────────── get_top_suppliers ───────────────────── */

export const getTopSuppliers: Tool = {
  name: "get_top_suppliers",
  description:
    "Suppliers ranked by outstanding balance (default — 'who we owe the most') or by PO volume in a period when period is passed. Use for 'who do I owe', 'biggest suppliers', 'most purchased from'. Numbers are server-computed in EGP.",
  requiredPermission: "view_suppliers",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 30 },
      by_volume: {
        type: "boolean",
        description:
          "Rank by PO volume in `period` instead of outstanding balance. When true, `period` is required.",
      },
      period: PERIOD_SCHEMA,
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const limit = parseLimit(args.limit, 10, 30);
    const byVolume = parseBool(args.by_volume);
    return withTenant(ctx.tenantId, async (tx) => {
      if (byVolume) {
        const period = parsePeriod(args.period ?? "month");
        const w = windowFor(period);
        const poFilters = [eq(purchaseOrders.tenantId, ctx.tenantId)];
        if (w) poFilters.push(gte(purchaseOrders.orderDate, w.from));

        const rows = await tx
          .select({
            supplierId: purchaseOrders.supplierId,
            name: sql<string>`max(${suppliers.name})`,
            poCount: sql<number>`count(*)::int`,
            volume: sql<string>`coalesce(sum(${purchaseOrders.total}), 0)::text`,
            paid: sql<string>`coalesce(sum(${purchaseOrders.paidAmount}), 0)::text`,
          })
          .from(purchaseOrders)
          .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
          .where(and(...poFilters))
          .groupBy(purchaseOrders.supplierId)
          .orderBy(sql`coalesce(sum(${purchaseOrders.total}), 0) desc`)
          .limit(limit);

        return {
          ok: true,
          data: {
            currency: "EGP",
            sortedBy: "po_volume",
            period,
            window: w
              ? { from: w.from.toISOString(), to: w.to.toISOString() }
              : null,
            suppliers: rows.map((r) => ({
              supplierId: r.supplierId,
              name: r.name,
              poCount: Number(r.poCount ?? 0),
              volume: Number(r.volume ?? 0),
              paid: Number(r.paid ?? 0),
              balance: Number(r.volume ?? 0) - Number(r.paid ?? 0),
            })),
          },
        };
      }

      // Default: rank by outstanding balance (what we owe them).
      const rows = await tx
        .select({
          id: suppliers.id,
          name: suppliers.name,
          phone: suppliers.phone,
          balance: suppliers.balance,
        })
        .from(suppliers)
        .where(eq(suppliers.tenantId, ctx.tenantId))
        .orderBy(sql`(${suppliers.balance})::numeric desc`)
        .limit(limit);

      return {
        ok: true,
        data: {
          currency: "EGP",
          sortedBy: "outstanding_balance",
          suppliers: rows.map((r) => ({
            supplierId: r.id,
            name: r.name,
            phone: r.phone,
            outstandingBalance: Number(r.balance ?? 0),
          })),
        },
      };
    });
  },
};
