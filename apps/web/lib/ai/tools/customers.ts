import { and, eq, ilike, isNotNull, or, sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { customerWallets, sales } from "@/lib/db/schema";
import { getCustomerLedger } from "@/lib/repo/customers";

import type { Tool } from "./types";
import { parseBool, parseLimit } from "./_shared";

export const getTopCustomers: Tool = {
  name: "get_top_customers",
  description:
    "Customers ranked by total spend (default) or by outstanding debt when by_debt=true. Use for 'top customers', 'who owes me', 'biggest spenders'.",
  requiredPermission: "view_customers",
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 30,
        description: "Max customers to return (default 10).",
      },
      by_debt: {
        type: "boolean",
        description: "Rank by outstanding debt instead of total spend.",
      },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const limit = parseLimit(args.limit, 10, 30);
    const byDebt = parseBool(args.by_debt);
    return withTenant(ctx.tenantId, async (tx) => {
      const filters = [
        eq(sales.tenantId, ctx.tenantId),
        isNotNull(sales.customerPhone),
      ];
      const rows = await tx
        .select({
          phone: sales.customerPhone,
          name: sql<string>`max(${sales.customerName})`,
          totalSpend: sql<string>`coalesce(sum(${sales.totalPrice}), 0)::text`,
          outstanding: sql<string>`coalesce(sum(${sales.totalPrice} - coalesce(${sales.amountPaid}, 0)), 0)::text`,
          invoiceCount: sql<number>`count(*)::int`,
        })
        .from(sales)
        .where(and(...filters))
        .groupBy(sales.customerPhone);

      const shaped = rows.map((r) => ({
        phone: r.phone,
        name: r.name,
        totalSpend: Number(r.totalSpend ?? 0),
        outstanding: Number(r.outstanding ?? 0),
        invoiceCount: Number(r.invoiceCount ?? 0),
      }));

      const sorted = shaped.sort((a, b) =>
        byDebt ? b.outstanding - a.outstanding : b.totalSpend - a.totalSpend,
      );
      return {
        ok: true,
        data: {
          currency: "EGP",
          sortedBy: byDebt ? "outstanding_debt" : "total_spend",
          customers: sorted.slice(0, limit),
        },
      };
    });
  },
};

/* ────────────────────────── F10.4 — findCustomer ───────────────────── */

/**
 * findCustomer — look up a customer by (partial) phone or (partial) name.
 *
 * Returns up to 10 candidates with phone + name + branch. Used by the agent
 * when the user says "who is Ahmed?" or "find customer 010…". Does NOT return
 * sensitive debit/credit — those come from getCustomerDetails after the user
 * picks one.
 */
export const findCustomer: Tool = {
  name: "find_customer",
  description:
    "Look up a customer by partial phone or partial name (case-insensitive). Returns up to 10 candidates with phone + name so the user can pick one. Use after questions like 'find Ahmed' / 'who is 010…'. For a specific customer's ledger (purchases, debt), call get_customer_details with the chosen phone.",
  requiredPermission: "view_customers",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 2, description: "Partial name or phone fragment." },
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
          phone: customerWallets.customerPhone,
          name: customerWallets.customerName,
          points: customerWallets.points,
          credit: customerWallets.credit,
        })
        .from(customerWallets)
        .where(
          and(
            eq(customerWallets.tenantId, ctx.tenantId),
            or(
              ilike(customerWallets.customerPhone, pattern),
              ilike(customerWallets.customerName, pattern),
            ),
          ),
        )
        .limit(limit);
      return {
        ok: true,
        data: {
          query: q,
          count: rows.length,
          customers: rows.map((r) => ({
            phone: r.phone,
            name: r.name ?? null,
            points: r.points ?? 0,
            credit: Number(r.credit ?? 0),
          })),
        },
      };
    });
  },
};

/* ────────────────────────── F10.4 — getCustomerDetails ─────────────── */

/**
 * getCustomerDetails — full ledger for one customer at one branch.
 *
 * Returns lifetime value, outstanding balance, invoice count, last visit,
 * and a bounded invoice list. Reuses the existing customer ledger repo
 * helper (same data path the mobile customer-detail page uses).
 */
export const getCustomerDetails: Tool = {
  name: "get_customer_details",
  description:
    "Get the full ledger for a specific customer at the active branch: lifetime value, outstanding balance, invoice count, last visit, recent invoices. Pass an exact phone (ideally one returned by find_customer). Requires view_customers.",
  requiredPermission: "view_customers",
  parameters: {
    type: "object",
    properties: {
      phone: {
        type: "string",
        minLength: 6,
        description: "Exact customer phone (as returned by find_customer).",
      },
    },
    required: ["phone"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const phone = String(args.phone ?? "").trim();
    if (!phone) return { ok: false, error: "EMPTY_PHONE" };
    // Tenant-scoped ledger (Storo has no branch feature). getCustomerLedger
    // accepts null and drops the legacy branch filter.
    const ledger = await getCustomerLedger(ctx.tenantId, null, phone);
    if (!ledger) {
      return { ok: true, data: { found: false, phone } };
    }
    return {
      ok: true,
      data: {
        found: true,
        phone: ledger.customerPhone,
        name: ledger.customerName,
        invoiceCount: ledger.invoiceCount,
        lifetimeValue: ledger.lifetimeValue,
        outstandingBalance: ledger.outstandingBalance,
        paidBalance: ledger.paidBalance,
        firstVisit: ledger.firstVisit?.toISOString() ?? null,
        lastVisit: ledger.lastVisit?.toISOString() ?? null,
        // Cap the invoice list so we don't blow out the LLM context.
        recentInvoices: ledger.invoices.slice(0, 8).map((inv) => ({
          invoiceId: inv.invoiceId,
          date: inv.date.toISOString(),
          total: inv.total,
          amountPaid: inv.amountPaid,
          balance: inv.balance,
          isPaid: inv.isPaid,
        })),
        currency: "EGP",
      },
    };
  },
};
