import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { sales, salePayments, cashShifts, cashMovements } from "@/lib/db/schema";

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
  /** Migration 0037: amount actually collected against this invoice.
   *  Sum of `amount_paid` across the invoice's lines. For legacy fully-
   *  paid rows it equals `total`; for partial-paid آجل rows it's
   *  whatever the customer has handed over so far. */
  amountPaid: number;
  /** Outstanding balance = total − amountPaid. Surfaced so the UI doesn't
   *  have to do the subtraction in three places. */
  balance: number;
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
    // Each invoice tracks BOTH total and amountPaid so partial-paid آجل
    // rows show the right balance per invoice instead of being treated
    // as fully unpaid (pre-Migration-0037 behaviour).
    type Acc = {
      invoiceId: string;
      saleIds: string[];
      date: Date;
      total: number;
      amountPaid: number;
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
      const linePaid = Number(r.amountPaid ?? 0);
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
        existing.amountPaid += linePaid;
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
          amountPaid: linePaid,
          isPaid: r.isPaid,
          paidAt: r.paidAt,
          paymentMethod: r.paymentMethod,
          lines: [line],
        });
      }
    }

    const invoices: LedgerInvoice[] = Array.from(byInvoice.values())
      .map((acc) => ({
        ...acc,
        balance: Math.max(0, acc.total - acc.amountPaid),
      }))
      .sort((a, b) => b.date.getTime() - a.date.getTime());

    // Receivables math: lifetimeValue is the total spent (counts both paid
    // and unpaid portions of every invoice). paidBalance is the actual
    // cash collected. outstandingBalance is what's still owed. The three
    // sum invariantly: paidBalance + outstandingBalance === lifetimeValue.
    let lifetimeValue = 0;
    let outstandingBalance = 0;
    let paidBalance = 0;
    for (const inv of invoices) {
      lifetimeValue += inv.total;
      outstandingBalance += inv.balance;
      paidBalance += inv.amountPaid;
    }

    return {
      customerName: rows[0].customerName,
      customerPhone,
      invoiceCount: invoices.length,
      lifetimeValue,
      outstandingBalance,
      paidBalance,
      firstVisit: invoices[invoices.length - 1]?.date ?? null,
      lastVisit: invoices[0]?.date ?? null,
      invoices,
    };
  });
}

export type SettlementMethod = "cash" | "instapay" | "card";

export interface MarkCustomerAllPaidActor {
  recordedByUserId: string;
  /** Method to stamp on each generated sale_payments row. Defaults to
   *  'cash' since the most common manual-settle flow is cash collected
   *  at the counter. */
  method?: SettlementMethod;
}

/**
 * Atomically mark every unpaid sale belonging to (branch, customer phone)
 * as paid. Migration 0037: amount_paid is bumped to total_price too so
 * the receivables aggregator on the customers page agrees with is_paid.
 * Migration 0038: every row touched also gets a sale_payments event for
 * the delta it collected, so the customer detail page shows a real
 * payment history.
 *
 * Returns the number of sales updated AND the actual cash collected
 * (which can be LESS than totalPrice when some rows were already partly
 * paid — the toast then reads the correct "collected X" figure).
 */
export async function markCustomerAllPaid(
  tenantId: string,
  branchId: string,
  customerPhone: string,
  actor: MarkCustomerAllPaidActor,
): Promise<{ markedCount: number; markedTotal: number }> {
  const method: SettlementMethod = actor.method ?? "cash";
  return withTenant(tenantId, async (tx) => {
    // Read first so we know the unpaid balance per row — that's what the
    // owner just collected, not the gross totalPrice (some rows might
    // already have a partial payment recorded against them).
    const rows = await tx
      .select({
        id: sales.id,
        totalPrice: sales.totalPrice,
        amountPaid: sales.amountPaid,
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

    // Bump amount_paid to total_price AND flip the boolean in one shot.
    // Raw SQL because Drizzle's `set()` can't reference another column.
    await tx.execute(sql`
      UPDATE sales
         SET amount_paid     = CAST(total_price AS numeric(14,2)),
             is_paid         = true,
             paid_at         = ${now},
             partial_paid_at = NULL
       WHERE tenant_id      = ${tenantId}
         AND branch_id      = ${branchId}
         AND customer_phone = ${customerPhone}
         AND is_returned    = false
         AND is_paid        = false
    `);

    // Resolve the active cash shift so cash settlements line up with the
    // drawer for Z-report. No shift = settlement still records, just no
    // drawer reconciliation. Same trade-off as settleCustomerPayment.
    let shiftId: string | null = null;
    if (method === "cash") {
      const [shift] = await tx
        .select({ id: cashShifts.id })
        .from(cashShifts)
        .where(
          and(
            eq(cashShifts.tenantId, tenantId),
            eq(cashShifts.branchId, branchId),
            eq(cashShifts.cashierUserId, actor.recordedByUserId),
            eq(cashShifts.status, "open"),
          ),
        )
        .limit(1);
      shiftId = shift?.id ?? null;
    }

    // One payment event per row touched, recording the actual delta
    // collected (not the gross totalPrice).
    let markedTotal = 0;
    const eventRows: typeof salePayments.$inferInsert[] = [];
    for (const r of rows) {
      const delta = Math.max(
        0,
        Number(r.totalPrice) - Number(r.amountPaid ?? 0),
      );
      if (delta <= 0) continue;
      markedTotal += delta;
      eventRows.push({
        tenantId,
        saleId: r.id,
        amount: String(delta),
        method,
        recordedAt: now,
        recordedByUserId: actor.recordedByUserId,
        cashShiftId: shiftId,
      });
    }
    if (eventRows.length > 0) {
      await tx.insert(salePayments).values(eventRows);
    }

    // Cash settlements: one aggregated cash_movements row so the cash
    // drawer shows ONE "customer pay-down" line, not one per invoice.
    if (method === "cash" && shiftId && markedTotal > 0) {
      await tx.insert(cashMovements).values({
        tenantId,
        shiftId,
        kind: "paid_in",
        amount: String(markedTotal),
        reason: `Customer settlement (bulk) — ${customerPhone}`,
        recordedByUserId: actor.recordedByUserId,
      });
    }

    return { markedCount: rows.length, markedTotal };
  });
}
