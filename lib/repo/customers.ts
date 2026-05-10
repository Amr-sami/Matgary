import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { sales } from "@/lib/db/schema";

// Customer ledger — read + mutate side. Customers are derived from
// sales.customer_phone (no separate customers table), so the "ledger"
// is a per-phone aggregate over the sales table for the active branch.
//
// Multi-store: scoped to one branch on purpose. Owner switching branches
// via the topbar sees the same customer's separate debt at each branch
// — matches the rest of the multi-store model where every read is
// branch-scoped.

export interface LedgerInvoice {
  /** Invoice id (groups multi-line carts). Falls back to sale id when
   *  the sale wasn't part of an invoice. */
  invoiceId: string;
  saleIds: string[];
  date: Date;
  total: number;
  isPaid: boolean;
  paidAt: Date | null;
  paymentMethod: string | null;
  /** Per-line summary for receipt-style display. */
  lines: Array<{
    saleId: string;
    productName: string;
    quantity: number;
    pricePerUnit: number;
    lineTotal: number;
  }>;
}

export interface CustomerLedger {
  customerName: string | null;
  customerPhone: string;
  invoiceCount: number;
  lifetimeValue: number;
  outstandingBalance: number;
  paidBalance: number;
  firstVisit: Date | null;
  lastVisit: Date | null;
  invoices: LedgerInvoice[];
}

/**
 * Pull every sale for one (branch, customer phone) and roll it up into
 * the ledger shape the detail page renders. Returns null when the
 * customer has zero non-returned sales at the active branch.
 */
export async function getCustomerLedger(
  tenantId: string,
  branchId: string,
  customerPhone: string,
): Promise<CustomerLedger | null> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, tenantId),
          eq(sales.branchId, branchId),
          eq(sales.customerPhone, customerPhone),
          eq(sales.isReturned, false),
        ),
      )
      .orderBy(sql`${sales.saleDate} desc`);

    if (rows.length === 0) return null;

    // Group sales rows by invoiceId (or fallback to sale id when null).
    type Acc = {
      invoiceId: string;
      saleIds: string[];
      date: Date;
      total: number;
      isPaid: boolean;
      paidAt: Date | null;
      paymentMethod: string | null;
      lines: LedgerInvoice["lines"];
    };
    const byInvoice = new Map<string, Acc>();
    for (const r of rows) {
      const id = r.invoiceId ?? r.id;
      const existing = byInvoice.get(id);
      const lineTotal = Number(r.totalPrice);
      const line = {
        saleId: r.id,
        productName: r.productName,
        quantity: r.quantitySold,
        pricePerUnit: Number(r.pricePerUnit),
        lineTotal,
      };
      if (existing) {
        existing.saleIds.push(r.id);
        existing.total += lineTotal;
        // An invoice is "paid" only if every line is paid; one unpaid
        // line keeps the whole invoice outstanding.
        if (!r.isPaid) existing.isPaid = false;
        existing.lines.push(line);
        // Prefer the latest paidAt across the lines.
        if (r.paidAt && (!existing.paidAt || r.paidAt > existing.paidAt)) {
          existing.paidAt = r.paidAt;
        }
      } else {
        byInvoice.set(id, {
          invoiceId: id,
          saleIds: [r.id],
          date: r.saleDate,
          total: lineTotal,
          isPaid: r.isPaid,
          paidAt: r.paidAt,
          paymentMethod: r.paymentMethod,
          lines: [line],
        });
      }
    }

    const invoices = Array.from(byInvoice.values()).sort(
      (a, b) => b.date.getTime() - a.date.getTime(),
    );

    let lifetimeValue = 0;
    let outstandingBalance = 0;
    for (const inv of invoices) {
      lifetimeValue += inv.total;
      if (!inv.isPaid) outstandingBalance += inv.total;
    }

    return {
      customerName: rows[0].customerName,
      customerPhone,
      invoiceCount: invoices.length,
      lifetimeValue,
      outstandingBalance,
      paidBalance: lifetimeValue - outstandingBalance,
      firstVisit: invoices[invoices.length - 1]?.date ?? null,
      lastVisit: invoices[0]?.date ?? null,
      invoices,
    };
  });
}

/**
 * Atomically mark every unpaid sale belonging to (branch, customer phone)
 * as paid. Returns the number of sale rows updated so the UI can show
 * "12 invoices marked paid". Idempotent — re-running is safe (no rows
 * to update on the second call).
 */
export async function markCustomerAllPaid(
  tenantId: string,
  branchId: string,
  customerPhone: string,
): Promise<{ markedCount: number; markedTotal: number }> {
  return withTenant(tenantId, async (tx) => {
    // Read first so we can sum the total for the activity log + UI toast.
    const rows = await tx
      .select({
        id: sales.id,
        totalPrice: sales.totalPrice,
        invoiceId: sales.invoiceId,
      })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, tenantId),
          eq(sales.branchId, branchId),
          eq(sales.customerPhone, customerPhone),
          eq(sales.isReturned, false),
          eq(sales.isPaid, false),
        ),
      );
    if (rows.length === 0) return { markedCount: 0, markedTotal: 0 };

    const now = new Date();
    await tx
      .update(sales)
      .set({ isPaid: true, paidAt: now })
      .where(
        and(
          eq(sales.tenantId, tenantId),
          eq(sales.branchId, branchId),
          eq(sales.customerPhone, customerPhone),
          eq(sales.isReturned, false),
          eq(sales.isPaid, false),
        ),
      );

    const markedTotal = rows.reduce((s, r) => s + Number(r.totalPrice), 0);
    return { markedCount: rows.length, markedTotal };
  });
}
