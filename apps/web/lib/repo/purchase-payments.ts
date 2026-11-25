import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  purchaseOrders,
  purchaseOrderPayments,
} from "@/lib/db/schema";
import { adjustSupplierBalance } from "./suppliers";
import { PurchaseOrderConflictError } from "./purchase-orders";

export type PurchasePaymentMethod = "cash" | "bank" | "vfcash" | "instapay" | "other";

export interface PurchaseOrderPayment {
  id: string;
  purchaseOrderId: string;
  supplierId: string;
  amount: number;
  method: PurchasePaymentMethod;
  paidAt: Date;
  notes: string | null;
  createdAt: Date;
}

export interface RecordPaymentInput {
  amount: number;
  method?: PurchasePaymentMethod;
  paidAt?: Date | null;
  notes?: string | null;
}

const PAYMENT_METHODS = new Set<PurchasePaymentMethod>([
  "cash",
  "bank",
  "vfcash",
  "instapay",
  "other",
]);

function rowToPayment(
  row: typeof purchaseOrderPayments.$inferSelect,
): PurchaseOrderPayment {
  return {
    id: row.id,
    purchaseOrderId: row.purchaseOrderId,
    supplierId: row.supplierId,
    amount: Number(row.amount),
    method: PAYMENT_METHODS.has(row.method as PurchasePaymentMethod)
      ? (row.method as PurchasePaymentMethod)
      : "other",
    paidAt: row.paidAt,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}

export async function listPayments(
  tenantId: string,
  purchaseOrderId: string,
): Promise<PurchaseOrderPayment[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(purchaseOrderPayments)
      .where(
        and(
          eq(purchaseOrderPayments.tenantId, tenantId),
          eq(purchaseOrderPayments.purchaseOrderId, purchaseOrderId),
        ),
      )
      .orderBy(desc(purchaseOrderPayments.paidAt), asc(purchaseOrderPayments.createdAt));
    return rows.map(rowToPayment);
  });
}

export interface ListSupplierPaymentsOptions {
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface SupplierPaymentHistory {
  supplierId: string;
  window: { from: Date | null; to: Date | null };
  totals: { paidInWindow: number; countInWindow: number };
  rows: PurchaseOrderPayment[];
}

/**
 * Supplier-level payment ledger across ALL of this supplier's purchase orders,
 * ordered newest-first. Pairs with `get_supplier_details` (which returns the
 * last 8 and the outstanding balance) when the caller needs the full history
 * or a date-ranged slice.
 *
 * `limit` is clamped server-side (default 50, max 200) so an unbounded Agent
 * call can't exhaust rows.
 */
export async function listSupplierPayments(
  tenantId: string,
  supplierId: string,
  opts: ListSupplierPaymentsOptions = {},
): Promise<SupplierPaymentHistory> {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  return withTenant(tenantId, async (tx) => {
    const filters = [
      eq(purchaseOrderPayments.tenantId, tenantId),
      eq(purchaseOrderPayments.supplierId, supplierId),
    ];
    if (opts.from) filters.push(gte(purchaseOrderPayments.paidAt, opts.from));
    if (opts.to) filters.push(lte(purchaseOrderPayments.paidAt, opts.to));

    const [agg] = await tx
      .select({
        totalPaid: sql<string>`coalesce(sum(${purchaseOrderPayments.amount}), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(purchaseOrderPayments)
      .where(and(...filters));

    const rows = await tx
      .select()
      .from(purchaseOrderPayments)
      .where(and(...filters))
      .orderBy(
        desc(purchaseOrderPayments.paidAt),
        asc(purchaseOrderPayments.createdAt),
      )
      .limit(limit);

    return {
      supplierId,
      window: {
        from: opts.from ?? null,
        to: opts.to ?? null,
      },
      totals: {
        paidInWindow: Number(agg?.totalPaid ?? 0),
        countInWindow: Number(agg?.count ?? 0),
      },
      rows: rows.map(rowToPayment),
    };
  });
}

/**
 * Lightweight supplier-scoped PO reader for W1.5 (`list_unpaid_purchase_orders`
 * in the Agent). Returns POs whose status = 'received' and
 * `total - paid_amount > 0` — i.e. the ones that actually carry outstanding
 * supplier payable. Draft POs are excluded because they haven't hit the
 * ledger yet.
 */
export interface UnpaidPurchaseOrderRow {
  id: string;
  supplierId: string;
  orderDate: Date;
  receivedDate: Date | null;
  status: string;
  total: number;
  paidAmount: number;
  outstanding: number;
}

export async function listUnpaidPurchaseOrdersBySupplier(
  tenantId: string,
  supplierId: string,
  opts: { from?: Date; to?: Date; limit?: number } = {},
): Promise<UnpaidPurchaseOrderRow[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 25), 100);
  return withTenant(tenantId, async (tx) => {
    const filters = [
      eq(purchaseOrders.tenantId, tenantId),
      eq(purchaseOrders.supplierId, supplierId),
      eq(purchaseOrders.status, "received"),
      sql`${purchaseOrders.total} > coalesce(${purchaseOrders.paidAmount}, 0)`,
    ];
    if (opts.from) filters.push(gte(purchaseOrders.orderDate, opts.from));
    if (opts.to) filters.push(lte(purchaseOrders.orderDate, opts.to));

    const rows = await tx
      .select({
        id: purchaseOrders.id,
        supplierId: purchaseOrders.supplierId,
        orderDate: purchaseOrders.orderDate,
        receivedDate: purchaseOrders.receivedDate,
        status: purchaseOrders.status,
        total: purchaseOrders.total,
        paidAmount: purchaseOrders.paidAmount,
      })
      .from(purchaseOrders)
      .where(and(...filters))
      .orderBy(desc(purchaseOrders.orderDate))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      supplierId: r.supplierId,
      orderDate: r.orderDate,
      receivedDate: r.receivedDate,
      status: r.status,
      total: Number(r.total),
      paidAmount: Number(r.paidAmount ?? 0),
      outstanding: Number(r.total) - Number(r.paidAmount ?? 0),
    }));
  });
}

/**
 * Record a payment against a PO. Atomically increments paid_amount, decrements
 * supplier.balance, and writes a payment row. Rejects payments that exceed
 * the outstanding remainder or target a PO that isn't in 'received' state.
 */
/**
 * Tx-scoped record payment. Same behaviour as recordPayment without opening
 * its own transaction — lets composite orchestrators (AI purchase + payment,
 * UI's receive-and-settle) share a single tx. Public recordPayment below
 * remains the one-shot helper used from REST routes.
 */
export async function _recordPaymentTx(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  purchaseOrderId: string,
  input: RecordPaymentInput,
): Promise<{ id: string }> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new PurchaseOrderConflictError("المبلغ يجب أن يكون أكبر من صفر");
  }
  const amount = Math.round(input.amount * 100) / 100;

  {
    const [po] = await tx
      .select({
        id: purchaseOrders.id,
        supplierId: purchaseOrders.supplierId,
        branchId: purchaseOrders.branchId,
        status: purchaseOrders.status,
        total: purchaseOrders.total,
        paidAmount: purchaseOrders.paidAmount,
      })
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.tenantId, tenantId),
          eq(purchaseOrders.id, purchaseOrderId),
        ),
      )
      .limit(1);

    if (!po) throw new PurchaseOrderConflictError("أمر الشراء غير موجود");
    if (po.status !== "received") {
      throw new PurchaseOrderConflictError(
        "يمكن تسجيل الدفعات فقط على أوامر تم استلامها",
      );
    }

    const total = Number(po.total);
    const paid = Number(po.paidAmount);
    const remaining = Math.round((total - paid) * 100) / 100;
    if (remaining <= 0) {
      throw new PurchaseOrderConflictError("هذا الأمر مسدد بالكامل");
    }
    if (amount > remaining + 0.001) {
      throw new PurchaseOrderConflictError(
        `المبلغ يتجاوز المتبقي (${remaining.toFixed(2)})`,
      );
    }

    const method: PurchasePaymentMethod = PAYMENT_METHODS.has(
      (input.method ?? "cash") as PurchasePaymentMethod,
    )
      ? (input.method ?? "cash")
      : "cash";

    const [created] = await tx
      .insert(purchaseOrderPayments)
      .values({
        tenantId,
        branchId: po.branchId,
        purchaseOrderId,
        supplierId: po.supplierId,
        amount: amount.toFixed(2),
        method,
        paidAt: input.paidAt ?? sql`now()`,
        notes: input.notes ?? null,
      })
      .returning({ id: purchaseOrderPayments.id });

    await tx
      .update(purchaseOrders)
      .set({
        paidAmount: sql`(${purchaseOrders.paidAmount})::numeric + ${amount.toFixed(2)}::numeric`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(purchaseOrders.tenantId, tenantId),
          eq(purchaseOrders.id, purchaseOrderId),
        ),
      );

    await adjustSupplierBalance(tx, tenantId, po.supplierId, -amount);

    return { id: created.id };
  }
}

export async function recordPayment(
  tenantId: string,
  purchaseOrderId: string,
  input: RecordPaymentInput,
): Promise<{ id: string }> {
  return withTenant(tenantId, (tx) =>
    _recordPaymentTx(tx, tenantId, purchaseOrderId, input),
  );
}

/**
 * Reverse a payment. Decrements paid_amount and re-credits supplier.balance
 * by the same amount. Cannot drop paid_amount below zero (would indicate
 * data corruption, so we throw instead of silently clamping).
 */
export async function deletePayment(
  tenantId: string,
  paymentId: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [payment] = await tx
      .select()
      .from(purchaseOrderPayments)
      .where(
        and(
          eq(purchaseOrderPayments.tenantId, tenantId),
          eq(purchaseOrderPayments.id, paymentId),
        ),
      )
      .limit(1);
    if (!payment) throw new PurchaseOrderConflictError("الدفعة غير موجودة");

    const [po] = await tx
      .select({
        paidAmount: purchaseOrders.paidAmount,
        supplierId: purchaseOrders.supplierId,
      })
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.tenantId, tenantId),
          eq(purchaseOrders.id, payment.purchaseOrderId),
        ),
      )
      .limit(1);
    if (!po) throw new PurchaseOrderConflictError("أمر الشراء غير موجود");

    const amount = Number(payment.amount);
    const currentPaid = Number(po.paidAmount);
    if (currentPaid + 0.001 < amount) {
      throw new PurchaseOrderConflictError(
        "تعذر إلغاء الدفعة — قيمة المدفوع أقل من المتوقع",
      );
    }

    await tx
      .delete(purchaseOrderPayments)
      .where(
        and(
          eq(purchaseOrderPayments.tenantId, tenantId),
          eq(purchaseOrderPayments.id, paymentId),
        ),
      );

    await tx
      .update(purchaseOrders)
      .set({
        paidAmount: sql`(${purchaseOrders.paidAmount})::numeric - ${amount.toFixed(2)}::numeric`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(purchaseOrders.tenantId, tenantId),
          eq(purchaseOrders.id, payment.purchaseOrderId),
        ),
      );

    await adjustSupplierBalance(tx, tenantId, po.supplierId, amount);
  });
}
