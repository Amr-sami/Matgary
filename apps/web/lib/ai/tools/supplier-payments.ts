import {
  listSupplierPayments,
  listUnpaidPurchaseOrdersBySupplier,
} from "@/lib/repo/purchase-payments";

import type { Tool } from "./types";
import {
  DATE_FROM_SCHEMA,
  DATE_TO_SCHEMA,
  parseLimit,
  resolveWindow,
} from "./_shared";

/**
 * W1.4 — supplier payment history.
 *
 * Supplements `get_supplier_details` (which returns the LAST 8 payments as
 * part of a composite view). When the user asks for the full history or a
 * date-ranged slice ("كل الدفعات لحسين", "الدفعات الشهر ده"), this tool is
 * the right one. All aggregation happens in the authoritative repo helper
 * `listSupplierPayments`; the Agent only chooses supplier + window.
 */
export const getSupplierPaymentHistory: Tool = {
  name: "get_supplier_payment_history",
  description:
    "All payments we made to ONE supplier across every PO, newest first, optionally scoped to a date range. Use for 'how much have I paid Hussein?', 'show all payments to X', 'what did I pay X this month?', 'when was the last payment to X?'. Returns window totals (paidInWindow, countInWindow) plus per-payment rows. Pass `supplier_id` (uuid from find_supplier / resolve_supplier). Server-side limit is clamped (default 50, max 200).",
  requiredPermission: "view_suppliers",
  parameters: {
    type: "object",
    properties: {
      supplier_id: {
        type: "string",
        minLength: 10,
        description: "Supplier uuid as returned by find_supplier / resolve_supplier.",
      },
      from: DATE_FROM_SCHEMA,
      to: DATE_TO_SCHEMA,
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        description: "Max rows (default 50). Totals cover the full window regardless.",
      },
    },
    required: ["supplier_id"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const supplierId = typeof args.supplier_id === "string" ? args.supplier_id.trim() : "";
    if (!supplierId) return { ok: false, error: "MISSING_SUPPLIER_ID" };

    const limit = parseLimit(args.limit, 50, 200);
    const resolved = resolveWindow(args);
    const w = resolved.window;

    const history = await listSupplierPayments(ctx.tenantId, supplierId, {
      from: w?.from,
      to: w?.to,
      limit,
    });

    return {
      ok: true,
      data: {
        supplierId,
        currency: "EGP",
        window: w
          ? { from: w.from.toISOString(), to: w.to.toISOString() }
          : null,
        totals: history.totals,
        rows: history.rows.map((r) => ({
          id: r.id,
          purchaseOrderId: r.purchaseOrderId,
          amount: r.amount,
          method: r.method,
          paidAt: r.paidAt.toISOString(),
          notes: r.notes,
        })),
      },
    };
  },
};

/**
 * W1.5 — list the supplier's purchase orders that still carry outstanding
 * payable (status = 'received' AND paid < total). Use BEFORE
 * preview_record_purchase_payment so the Agent can either auto-pick the
 * single open PO or ask the user which one to allocate to. Draft POs are
 * excluded — they haven't hit the ledger yet.
 */
export const listUnpaidPurchaseOrders: Tool = {
  name: "list_unpaid_purchase_orders",
  description:
    "POs for ONE supplier that still have outstanding supplier payable (status='received' AND paid < total), newest first. Use BEFORE preview_record_purchase_payment: one PO with balance → use that id; multiple → list them and ask the user which to allocate against. NEVER silently pick the oldest. Totals (outstandingTotal, count) are returned alongside the rows. Optional date range filters on orderDate.",
  requiredPermission: "view_purchases",
  parameters: {
    type: "object",
    properties: {
      supplier_id: {
        type: "string",
        minLength: 10,
        description: "Supplier uuid as returned by find_supplier / resolve_supplier.",
      },
      from: DATE_FROM_SCHEMA,
      to: DATE_TO_SCHEMA,
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Max rows (default 25). Totals cover the full filtered set.",
      },
    },
    required: ["supplier_id"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const supplierId = typeof args.supplier_id === "string" ? args.supplier_id.trim() : "";
    if (!supplierId) return { ok: false, error: "MISSING_SUPPLIER_ID" };

    const limit = parseLimit(args.limit, 25, 100);
    const resolved = resolveWindow(args);
    const w = resolved.window;

    const rows = await listUnpaidPurchaseOrdersBySupplier(ctx.tenantId, supplierId, {
      from: w?.from,
      to: w?.to,
      limit,
    });

    const outstandingTotal = rows.reduce((s, r) => s + r.outstanding, 0);

    return {
      ok: true,
      data: {
        supplierId,
        currency: "EGP",
        window: w
          ? { from: w.from.toISOString(), to: w.to.toISOString() }
          : null,
        totals: {
          outstandingTotal: Math.round(outstandingTotal * 100) / 100,
          count: rows.length,
        },
        rows: rows.map((r) => ({
          purchaseOrderId: r.id,
          orderDate: r.orderDate.toISOString(),
          receivedDate: r.receivedDate?.toISOString() ?? null,
          status: r.status,
          total: r.total,
          paidAmount: r.paidAmount,
          outstanding: r.outstanding,
        })),
      },
    };
  },
};
