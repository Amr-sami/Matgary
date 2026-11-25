import { and, count, eq, gt } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { customerWallets, sales } from "@/lib/db/schema";

import type { OperationRecord } from "./types";

/* ───────────────────── forward declarations ─────────────────────── */

/**
 * F10.0 — Dependency protection.
 *
 * Before executing a destructive rollback (customer.create delete), check
 * whether any dependent business data exists. Non-destructive rollbacks
 * (field restores on products) don't go through dependency checks because
 * restoring an older price/quantity doesn't affect downstream rows.
 *
 * Per-entity-type detection lives here so new entity types just add a case.
 */

export interface DependencyBlock {
  /** Machine-readable reason — surfaces to RollbackConflictBlock.code. */
  code: string;
  /** User-facing reason assembled server-side (localised by caller). */
  message: string;
  /** Counts for display. */
  counts?: Record<string, number>;
}

/**
 * Check for dependencies that would block a rollback. Returns null when
 * rollback is safe; returns a DependencyBlock otherwise.
 */
export async function checkDependencies(
  op: OperationRecord,
): Promise<DependencyBlock | null> {
  switch (op.operationType) {
    case "customer.create":
      return checkCustomerCreateDependencies(op);
    case "product.create":
      return checkProductCreateDependencies(op);
    // Field restores on products (price / quantity) don't require dependency
    // checks — they overwrite values without destroying downstream rows.
    // (A historical sale carries its own snapshot of `product_name`, `brand`,
    // etc. — see `sales` table — so changing the current price doesn't
    // retroactively alter past sales.)
    case "product.price.update":
    case "product.quantity.update":
    case "product.quantity.adjust":
      return null;
    default:
      return null;
  }
}

async function checkProductCreateDependencies(
  op: OperationRecord,
): Promise<DependencyBlock | null> {
  if (!op.entityId) {
    return { code: "MISSING_ENTITY_ID", message: "Product id missing from operation record." };
  }
  // Any sale lines referencing this product block the delete rollback: those
  // sales snapshot product_name + price so SQL would allow the delete only
  // because `sales.product_id` is `ON DELETE RESTRICT`. We check in
  // application code too so we can emit a human-readable block.
  return withTenant(op.tenantId, async (tx): Promise<DependencyBlock | null> => {
    const [salesCount] = await tx
      .select({ n: count() })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, op.tenantId),
          eq(sales.productId, op.entityId!),
        ),
      );
    const n = Number(salesCount?.n ?? 0);
    if (n > 0) {
      return {
        code: "PRODUCT_HAS_SALES",
        message: "The product has sales history; deleting it would corrupt sales lineage.",
        counts: { sales: n },
      };
    }
    return null;
  });
}

async function checkCustomerCreateDependencies(
  op: OperationRecord,
): Promise<DependencyBlock | null> {
  const key = (op.entityKey ?? {}) as { branchId?: string; phone?: string };
  if (!key.branchId || !key.phone) {
    return {
      code: "MISSING_ENTITY_KEY",
      message: "Customer identity information is missing from the operation record.",
    };
  }
  // 1. Any sales linked to this customer phone? A sale table doesn't reference
  //    customer_wallets by uuid — it carries `customer_phone` — so this is a
  //    phone-based lookup.
  // 2. Any loyalty points or credit accrued on the wallet row? If so, the
  //    wallet no longer matches `before_state: { exists: false }` — deleting
  //    it would destroy audit trail of those accruals.
  return withTenant(op.tenantId, async (tx): Promise<DependencyBlock | null> => {
    const [wallet] = await tx
      .select({
        points: customerWallets.points,
        credit: customerWallets.credit,
      })
      .from(customerWallets)
      .where(
        and(
          eq(customerWallets.tenantId, op.tenantId),
          eq(customerWallets.branchId, key.branchId!),
          eq(customerWallets.customerPhone, key.phone!),
        ),
      );
    if (!wallet) {
      // Row already gone — nothing to delete. Caller treats this as "already
      // reverted" rather than a dependency block.
      return { code: "ALREADY_REMOVED", message: "Customer no longer exists." };
    }
    if ((wallet.points ?? 0) !== 0 || Number(wallet.credit ?? 0) !== 0) {
      return {
        code: "CUSTOMER_HAS_BALANCE",
        message:
          "The customer has accrued points or credit since creation; delete would destroy balance history.",
        counts: {
          points: wallet.points ?? 0,
          credit: Number(wallet.credit ?? 0),
        },
      };
    }
    // Sales referencing this customer (by phone).
    const [salesCount] = await tx
      .select({ n: count() })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, op.tenantId),
          eq(sales.customerPhone, key.phone!),
        ),
      );
    const n = Number(salesCount?.n ?? 0);
    if (n > 0) {
      return {
        code: "CUSTOMER_HAS_SALES",
        message:
          "The customer has sales history; delete would corrupt sales lineage.",
        counts: { sales: n },
      };
    }
    return null;
  });
}

/**
 * Lightweight export — returns true if an operation would be destructive to
 * reverse. Used by the rollback preview to flag "requires stronger
 * confirmation" in the UI.
 */
export function isDestructiveRollback(op: OperationRecord): boolean {
  // Deleting a freshly-created customer or product IS destructive.
  if (op.operationType === "customer.create") return true;
  if (op.operationType === "product.create") return true;
  // Field-restores are not destructive.
  return false;
}

/** Suppress unused import when a specific path doesn't reference `gt`. */
void gt;
