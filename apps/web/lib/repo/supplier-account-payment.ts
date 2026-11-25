// Supplier account-level payment — the default "I paid Hussein 10,000"
// interpretation.
//
// Unlike `recordPayment` (purchase-payments.ts) which allocates against a
// specific PO, this records a payment against the supplier's aggregate
// outstanding balance. Two primitives are composed in one transaction so the
// supplier balance and the money-movement ledger can never diverge:
//
//   1. INSERT a money_movements row with kind='supplier_payment_direct',
//      related_entity_type='supplier', related_entity_id=supplierId. This is
//      the authoritative audit trail + cashflow entry. The P&L engine
//      already excludes this kind (lib/finance/pnl.ts line 60-62) so the
//      payment is NEVER counted as an operating expense.
//
//   2. decrement `suppliers.balance` by the payment amount via the existing
//      `adjustSupplierBalance` helper — same column every PO-level payment
//      already writes to.
//
// Per-PO `paid_amount` is intentionally NOT touched: this payment is NOT
// allocated to any specific invoice. Callers that want invoice-level
// allocation must use `recordPayment(purchaseOrderId, …)` instead.
//
// The two numbers callers read today — `suppliers.balance` (net payable)
// and Σ(po.total − po.paidAmount) (per-invoice payable) — are allowed to
// diverge after this write: the difference is the account-level credit the
// user has paid against the supplier without allocating it to a specific PO.
// That divergence IS the business state (untied credit); it's not a bug.

import "server-only";

import { and, eq } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { moneyMovements, suppliers } from "@/lib/db/schema";
import { adjustSupplierBalance } from "./suppliers";

export type SupplierAccountPaymentMethod =
  | "cash"
  | "bank"
  | "vfcash"
  | "instapay"
  | "other";

const PAYMENT_METHODS = new Set<SupplierAccountPaymentMethod>([
  "cash",
  "bank",
  "vfcash",
  "instapay",
  "other",
]);

export interface RecordSupplierAccountPaymentInput {
  amount: number;
  method?: SupplierAccountPaymentMethod;
  paidAt?: Date | null;
  notes?: string | null;
  createdByUserId: string;
}

export interface RecordSupplierAccountPaymentResult {
  movementId: string;
  supplierId: string;
  supplierName: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  method: SupplierAccountPaymentMethod;
  paidAt: Date;
}

export class SupplierAccountPaymentError extends Error {
  constructor(
    public code:
      | "SUPPLIER_NOT_FOUND"
      | "INVALID_AMOUNT"
      | "AMOUNT_EXCEEDS_BALANCE",
    public details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${JSON.stringify(details)}`);
  }
}

/**
 * Record a supplier account-level payment. See file header for the exact
 * accounting semantics. ATOMIC: all three steps (load supplier, insert
 * movement, decrement balance) run in a single `withTenant` transaction so
 * concurrent callers can't observe a half-applied state.
 *
 * Rejects:
 *   - amount <= 0                       → INVALID_AMOUNT
 *   - supplier not in tenant            → SUPPLIER_NOT_FOUND
 *   - amount > current supplier.balance → AMOUNT_EXCEEDS_BALANCE
 *     (the caller is expected to surface "the owner owes 7,500; refusing
 *     to accept a 10,000 payment that would make the account credit" —
 *     Storo has no supplier-credit concept yet, so the ceiling is enforced).
 */
export async function recordSupplierAccountPayment(
  tenantId: string,
  supplierId: string,
  input: RecordSupplierAccountPaymentInput,
): Promise<RecordSupplierAccountPaymentResult> {
  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new SupplierAccountPaymentError("INVALID_AMOUNT", { amount: input.amount });
  }

  const method: SupplierAccountPaymentMethod = PAYMENT_METHODS.has(
    (input.method ?? "cash") as SupplierAccountPaymentMethod,
  )
    ? (input.method ?? "cash")
    : "cash";
  const paidAt = input.paidAt ?? new Date();

  return withTenant(tenantId, async (tx) => {
    const [sup] = await tx
      .select({
        id: suppliers.id,
        name: suppliers.name,
        balance: suppliers.balance,
      })
      .from(suppliers)
      .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.id, supplierId)))
      .limit(1);
    if (!sup) {
      throw new SupplierAccountPaymentError("SUPPLIER_NOT_FOUND", { supplierId });
    }
    const balanceBefore = Number(sup.balance ?? 0);
    if (amount > balanceBefore + 0.001) {
      throw new SupplierAccountPaymentError("AMOUNT_EXCEEDS_BALANCE", {
        supplierId,
        amount,
        balance: balanceBefore,
      });
    }

    const [movement] = await tx
      .insert(moneyMovements)
      .values({
        tenantId,
        kind: "supplier_payment_direct",
        amount: amount.toFixed(2),
        occurredAt: paidAt,
        description: input.notes ?? null,
        paymentMethod: method,
        relatedEntityType: "supplier",
        relatedEntityId: supplierId,
        createdByUserId: input.createdByUserId,
      })
      .returning({ id: moneyMovements.id });

    await adjustSupplierBalance(tx, tenantId, supplierId, -amount);

    const balanceAfter = Math.round((balanceBefore - amount) * 100) / 100;

    return {
      movementId: movement.id,
      supplierId,
      supplierName: sup.name,
      amount,
      balanceBefore,
      balanceAfter,
      method,
      paidAt,
    };
  });
}
