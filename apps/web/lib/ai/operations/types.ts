/**
 * F10.0 — Reversible AI operation types.
 *
 * `OperationType` is a closed set of operation classes the rollback engine
 * knows how to reverse. Adding a new one requires:
 *   1. A case in buildRollbackPreview / executeRollback (concurrency check +
 *      restore path).
 *   2. A per-entity dependency check in dependency.ts.
 *   3. The F5 executor records the new type after a successful write.
 *
 * Mapping of the current F5 writes:
 *   • update_product_price    → "product.price.update"
 *   • update_product_quantity → "product.quantity.update" (mode=set) OR
 *                               "product.quantity.adjust" (mode=increase|decrease)
 *   • create_customer         → "customer.create"
 */
export type OperationType =
  | "product.price.update"
  | "product.quantity.update"
  | "product.quantity.adjust"
  // F10.1 — product creates (e.g. from an XLSX import). Rollback = DELETE.
  | "product.create"
  // Wave 1 — authoring updates other than price/quantity (name/brand/sku/
  // category/costPrice/threshold). Rollback = PATCH back to beforeState.
  | "product.update"
  | "customer.create";

export type EntityType = "product" | "customer";

export type OperationStatus =
  | "recorded"
  | "rolled_back"
  | "rollback_blocked"
  | "partially_rolled_back";

export interface OperationRecord {
  id: string;
  tenantId: string;
  userId: string;
  branchId: string | null;
  conversationId: string | null;
  operationType: OperationType;
  pendingActionId: string | null;
  operationGroupId: string | null;
  entityType: EntityType;
  entityId: string | null;
  entityLabel: string;
  entityKey: Record<string, unknown> | null;
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
  affectedFields: string[];
  reversible: boolean;
  status: OperationStatus;
  statusReason: string | null;
  expiresAt: Date | null;
  rollbackOperationId: string | null;
  actorName: string | null;
  idempotencyKey: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/** The input shape a successful write hands to `recordOperation`. */
export interface RecordOperationInput {
  tenantId: string;
  userId: string;
  branchId: string | null;
  conversationId: string | null;
  operationType: OperationType;
  pendingActionId: string | null;
  operationGroupId: string | null;
  entityType: EntityType;
  entityId: string | null;
  entityLabel: string;
  entityKey?: Record<string, unknown> | null;
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
  affectedFields: string[];
  actorName?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
  /** Default: 30 days from now. Pass null to mean "never auto-expires". */
  expiresAt?: Date | null;
}
