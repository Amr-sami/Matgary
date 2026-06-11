import { and, asc, desc, eq, sql } from "drizzle-orm";
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

/**
 * Record a payment against a PO. Atomically increments paid_amount, decrements
 * supplier.balance, and writes a payment row. Rejects payments that exceed
 * the outstanding remainder or target a PO that isn't in 'received' state.
 */
export async function recordPayment(
  tenantId: string,
  purchaseOrderId: string,
  input: RecordPaymentInput,
): Promise<{ id: string }> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new PurchaseOrderConflictError("المبلغ يجب أن يكون أكبر من صفر");
  }
  const amount = Math.round(input.amount * 100) / 100;

  return withTenant(tenantId, async (tx) => {
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
  });
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
