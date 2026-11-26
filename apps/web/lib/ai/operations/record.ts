import { and, desc, eq, gt, isNull, or } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { aiOperations, type AiOperationRow } from "@/lib/db/schema";

import type {
  OperationRecord,
  OperationStatus,
  OperationType,
  RecordOperationInput,
} from "./types";

/**
 * F10.0 — Operation recording + retrieval.
 *
 * Writes happen inside `withTenant` so RLS sees the right tenant_id. Reads
 * for the "undo that" path also run in `withTenant`; the LLM has no path to
 * provide a tenantId — it always comes from AgentContext.
 *
 * A failed INSERT is NOT fatal for the business write — the executor still
 * returned success and the audit row (F5.1) is independent. But the user
 * loses the "undo" affordance for that write; the executor surfaces a
 * WarningBlock(code=OPERATION_RECORD_FAILED) so ops can backfill if needed.
 */

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function recordOperation(
  input: RecordOperationInput,
): Promise<OperationRecord> {
  const expires =
    input.expiresAt === undefined
      ? new Date(Date.now() + DEFAULT_WINDOW_MS)
      : input.expiresAt;
  const row = await withTenant(input.tenantId, async (tx) => {
    const [inserted] = await tx
      .insert(aiOperations)
      .values({
        tenantId: input.tenantId,
        userId: input.userId,
        branchId: input.branchId,
        conversationId: input.conversationId,
        operationType: input.operationType,
        pendingActionId: input.pendingActionId,
        operationGroupId: input.operationGroupId,
        entityType: input.entityType,
        entityId: input.entityId,
        entityLabel: input.entityLabel,
        entityKey: input.entityKey ?? null,
        beforeState: input.beforeState,
        afterState: input.afterState,
        affectedFields: input.affectedFields,
        reversible: true,
        status: "recorded",
        expiresAt: expires,
        actorName: input.actorName ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        metadata: input.metadata ?? {},
      })
      .returning();
    return inserted!;
  });
  return rowToRecord(row);
}

/**
 * Fetch an operation by id, scoped to tenant AND user. Reversibility is an
 * attribute of the operation itself; this fetch is deliberately permissive
 * with `status` so `rollback_blocked` operations can still be inspected.
 */
export async function fetchOperationById(opts: {
  tenantId: string;
  operationId: string;
}): Promise<OperationRecord | null> {
  const row = await withTenant(opts.tenantId, async (tx) => {
    const [r] = await tx
      .select()
      .from(aiOperations)
      .where(
        and(
          eq(aiOperations.id, opts.operationId),
          eq(aiOperations.tenantId, opts.tenantId),
        ),
      );
    return r ?? null;
  });
  return row ? rowToRecord(row) : null;
}

/**
 * Find the user's most recent reversible operation in this conversation —
 * the backbone of "undo that" natural language.
 *
 * Filters:
 *   • same tenant, same user (ownership)
 *   • same conversationId when provided — prevents "undo" in a new chat
 *     from reverting an older chat's writes
 *   • same branchId when provided — a branch switch between the write and
 *     the undo disqualifies the record from this query (see F6 branch
 *     isolation; rollback enforces the same bar)
 *   • status = 'recorded' (not already rolled back)
 *   • expires_at > now OR expires_at IS NULL
 */
export async function findLastRecordedOperation(opts: {
  tenantId: string;
  userId: string;
  conversationId: string | null;
  branchId: string | null;
  /** Narrow to a specific entity family; omit for "any". */
  entityType?: "product" | "customer";
}): Promise<OperationRecord | null> {
  const now = new Date();
  const row = await withTenant(opts.tenantId, async (tx) => {
    const conditions: Array<ReturnType<typeof eq>> = [
      eq(aiOperations.tenantId, opts.tenantId),
      eq(aiOperations.userId, opts.userId),
      eq(aiOperations.status, "recorded"),
      eq(aiOperations.reversible, true),
      // expires_at IS NULL OR expires_at > now
      or(isNull(aiOperations.expiresAt), gt(aiOperations.expiresAt, now))!,
    ];
    if (opts.conversationId) {
      conditions.push(eq(aiOperations.conversationId, opts.conversationId));
    }
    if (opts.branchId) {
      conditions.push(eq(aiOperations.branchId, opts.branchId));
    }
    if (opts.entityType) {
      conditions.push(eq(aiOperations.entityType, opts.entityType));
    }
    const [r] = await tx
      .select()
      .from(aiOperations)
      .where(and(...conditions))
      .orderBy(desc(aiOperations.createdAt))
      .limit(1);
    return r ?? null;
  });
  return row ? rowToRecord(row) : null;
}

/**
 * Mark an operation after a rollback attempt. Writes are idempotent — the
 * rollback executor calls this exactly once per attempt.
 */
export async function markOperationStatus(opts: {
  tenantId: string;
  operationId: string;
  status: OperationStatus;
  statusReason?: string;
  rollbackOperationId?: string | null;
}): Promise<void> {
  await withTenant(opts.tenantId, async (tx) => {
    await tx
      .update(aiOperations)
      .set({
        status: opts.status,
        statusReason: opts.statusReason ?? null,
        rollbackOperationId: opts.rollbackOperationId ?? null,
      })
      .where(
        and(
          eq(aiOperations.id, opts.operationId),
          eq(aiOperations.tenantId, opts.tenantId),
        ),
      );
  });
}

/* ───────────────────────── helpers ──────────────────────────────────── */

function rowToRecord(row: AiOperationRow): OperationRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    branchId: row.branchId ?? null,
    conversationId: row.conversationId ?? null,
    operationType: row.operationType as OperationType,
    pendingActionId: row.pendingActionId ?? null,
    operationGroupId: row.operationGroupId ?? null,
    entityType: row.entityType as "product" | "customer",
    entityId: row.entityId ?? null,
    entityLabel: row.entityLabel,
    entityKey: (row.entityKey as Record<string, unknown> | null) ?? null,
    beforeState: row.beforeState as Record<string, unknown>,
    afterState: row.afterState as Record<string, unknown>,
    affectedFields: row.affectedFields as string[],
    reversible: row.reversible,
    status: row.status as OperationStatus,
    statusReason: row.statusReason ?? null,
    expiresAt: row.expiresAt ?? null,
    rollbackOperationId: row.rollbackOperationId ?? null,
    actorName: row.actorName ?? null,
    idempotencyKey: row.idempotencyKey ?? null,
    metadata: row.metadata as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}
