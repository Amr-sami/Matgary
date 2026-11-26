import { and, eq } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { customerWallets, products } from "@/lib/db/schema";
import { deleteProduct, updateProduct, listProducts } from "@/lib/repo/catalog";
import { insertActivityRow } from "@/lib/repo/activity";

import { checkDependencies, isDestructiveRollback, type DependencyBlock } from "./dependency";
import { markOperationStatus, recordOperation } from "./record";
import type { OperationRecord, OperationType } from "./types";

/**
 * F10.0 — Rollback engine.
 *
 * Two public functions:
 *   • `buildRollbackPreview(op)` — classifies an operation into one of:
 *       ready               → safe to roll back
 *       expired             → rollback window closed
 *       already_reverted    → the operation was already rolled back
 *       concurrent_change   → live state no longer matches afterState
 *       dependency_blocked  → dependent rows exist (destructive rollbacks)
 *       not_reversible      → the operation was recorded with reversible=false
 *   • `executeRollback(op)` — restores beforeState for a `ready` operation.
 *     Returns success + the restored state, or a conflict. Writes an
 *     activity_log row AND a new ai_operations record for the rollback
 *     itself (so the forward chain stays queryable).
 *
 * Both functions ONLY trust the server-stored `OperationRecord`. The LLM
 * never provides before/after values — it only names the operation to undo.
 */

/* ───────────────────────── types ──────────────────────────────────────── */

export type RollbackReadiness =
  | { kind: "ready"; preview: RollbackPreview }
  | { kind: "expired" }
  | { kind: "already_reverted"; rollbackOperationId: string | null }
  | { kind: "concurrent_change"; current: Record<string, unknown>; expected: Record<string, unknown> }
  | { kind: "dependency_blocked"; block: DependencyBlock }
  | { kind: "not_reversible" }
  | { kind: "entity_missing" };

export interface RollbackPreview {
  operationId: string;
  operationType: OperationType;
  entityType: "product" | "customer";
  entityId: string | null;
  entityLabel: string;
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
  /** Server-computed current state — what the engine will restore FROM. */
  currentState: Record<string, unknown>;
  affectedFields: string[];
  /** True → UI shows stronger confirmation copy. */
  destructive: boolean;
  /** True → rollback uses a transaction and is all-or-nothing. */
  transactional: boolean;
}

export type RollbackExecuteResult =
  | { ok: true; restoredState: Record<string, unknown>; rollbackOperationId: string }
  | { ok: false; kind: RollbackReadiness["kind"] | "write_failed" | "verify_failed"; reason: string };

/* ───────────────────────── preview ──────────────────────────────────── */

/**
 * Determine whether a recorded operation can safely be rolled back right now,
 * and build the preview the user confirms. Pure read + comparison — no writes.
 */
export async function buildRollbackPreview(
  op: OperationRecord,
): Promise<RollbackReadiness> {
  if (!op.reversible) return { kind: "not_reversible" };
  if (op.status === "rolled_back") {
    return { kind: "already_reverted", rollbackOperationId: op.rollbackOperationId };
  }
  if (op.expiresAt && op.expiresAt.getTime() < Date.now()) {
    return { kind: "expired" };
  }

  // Fetch the current live state for concurrency comparison.
  const currentState = await fetchCurrentState(op);
  if (!currentState) {
    return { kind: "entity_missing" };
  }

  // Concurrency check — did ANY watched field drift from afterState?
  const drift = diffWatchedFields(op.afterState, currentState, op.affectedFields);
  if (drift) {
    return {
      kind: "concurrent_change",
      current: drift.current,
      expected: drift.expected,
    };
  }

  // Dependency check (destructive rollbacks only).
  if (isDestructiveRollback(op)) {
    const block = await checkDependencies(op);
    if (block) {
      if (block.code === "ALREADY_REMOVED") {
        // Edge case: the row has already been deleted by another path. From
        // the user's perspective this is effectively "already reverted".
        return { kind: "already_reverted", rollbackOperationId: null };
      }
      return { kind: "dependency_blocked", block };
    }
  }

  return {
    kind: "ready",
    preview: {
      operationId: op.id,
      operationType: op.operationType,
      entityType: op.entityType,
      entityId: op.entityId,
      entityLabel: op.entityLabel,
      beforeState: op.beforeState,
      afterState: op.afterState,
      currentState,
      affectedFields: op.affectedFields,
      destructive: isDestructiveRollback(op),
      transactional: op.operationType === "customer.create",
    },
  };
}

/* ───────────────────────── execute ──────────────────────────────────── */

/**
 * Execute a rollback. Called by the F5 confirm executor when a
 * pending-action with action="rollback" is consumed. Re-runs the
 * concurrency + dependency checks (TOCTOU window since preview) and then
 * restores the before state, writes an audit row, flips the source
 * operation to `rolled_back`, and records a NEW ai_operations row
 * representing the undo itself.
 */
export async function executeRollback(opts: {
  op: OperationRecord;
  actorUserId: string;
  actorName: string | null;
  conversationId: string | null;
}): Promise<RollbackExecuteResult> {
  const { op } = opts;
  const readiness = await buildRollbackPreview(op);
  if (readiness.kind !== "ready") {
    return {
      ok: false,
      kind: readiness.kind,
      reason: readinessReason(readiness),
    };
  }

  try {
    const restored = await applyRestore(op);
    if (!restored.ok) {
      return { ok: false, kind: "write_failed", reason: restored.reason };
    }

    // Record the rollback as its own ai_operations row. The forward chain
    // becomes:  original (status=recorded) → rollback (status=recorded)
    //          →update: original.status='rolled_back', rollback_operation_id=rollback.id
    const rollbackOp = await recordOperation({
      tenantId: op.tenantId,
      userId: opts.actorUserId,
      branchId: op.branchId,
      conversationId: opts.conversationId,
      operationType: op.operationType, // same type, so the audit chain is readable
      pendingActionId: null,
      operationGroupId: null,
      entityType: op.entityType,
      entityId: op.entityId,
      entityLabel: op.entityLabel,
      entityKey: op.entityKey,
      // The rollback inverts the direction: what was before is now after,
      // what was after is now the state we rolled FROM (= before).
      beforeState: op.afterState,
      afterState: restored.state,
      affectedFields: op.affectedFields,
      actorName: opts.actorName,
      metadata: {
        kind: "rollback",
        originalOperationId: op.id,
      },
      // Rollbacks themselves are reversible — the user can "redo" by rolling
      // back the rollback. Window: 30 days from NOW (not from the original).
    });

    await markOperationStatus({
      tenantId: op.tenantId,
      operationId: op.id,
      status: "rolled_back",
      rollbackOperationId: rollbackOp.id,
    });

    // Audit row — mirrors the forward-write convention from F5.1.
    await writeAuditRow({
      tenantId: op.tenantId,
      actorUserId: opts.actorUserId,
      actorName: opts.actorName,
      branchId: op.branchId,
      op,
      restored: restored.state,
      rollbackOperationId: rollbackOp.id,
    });

    return { ok: true, restoredState: restored.state, rollbackOperationId: rollbackOp.id };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await markOperationStatus({
      tenantId: op.tenantId,
      operationId: op.id,
      status: "rollback_blocked",
      statusReason: reason,
    });
    return { ok: false, kind: "write_failed", reason };
  }
}

/* ───────────────────────── restore primitives ────────────────────────── */

async function applyRestore(
  op: OperationRecord,
): Promise<{ ok: true; state: Record<string, unknown> } | { ok: false; reason: string }> {
  switch (op.operationType) {
    case "product.price.update": {
      if (!op.entityId) return { ok: false, reason: "missing_entity_id" };
      const beforePrice = toFiniteNumber(op.beforeState.price);
      if (beforePrice == null) return { ok: false, reason: "missing_before_price" };
      const ok = await updateProduct(op.tenantId, op.entityId, { price: beforePrice });
      if (!ok) return { ok: false, reason: "update_failed" };
      const after = await getProductById(op.tenantId, op.entityId);
      if (!after || Number(after.price) !== beforePrice) {
        return { ok: false, reason: "post_verify_failed" };
      }
      return { ok: true, state: { price: Number(after.price) } };
    }
    case "product.quantity.update":
    case "product.quantity.adjust": {
      if (!op.entityId) return { ok: false, reason: "missing_entity_id" };
      const beforeQty = toFiniteNumber(op.beforeState.quantity);
      if (beforeQty == null) return { ok: false, reason: "missing_before_quantity" };
      // ALWAYS "set" on restore — we restore the BEFORE value, not the inverse.
      const ok = await updateProduct(op.tenantId, op.entityId, {
        quantity: Math.floor(beforeQty),
      });
      if (!ok) return { ok: false, reason: "update_failed" };
      const after = await getProductById(op.tenantId, op.entityId);
      if (!after || after.quantity !== Math.floor(beforeQty)) {
        return { ok: false, reason: "post_verify_failed" };
      }
      return { ok: true, state: { quantity: after.quantity } };
    }
    case "product.create": {
      if (!op.entityId) return { ok: false, reason: "missing_entity_id" };
      // Re-validate dependencies at write time (TOCTOU window).
      const dep = await checkDependencies(op);
      if (dep && dep.code !== "ALREADY_REMOVED") {
        return { ok: false, reason: `dependency_blocked:${dep.code}` };
      }
      const ok = await deleteProduct(op.tenantId, op.entityId);
      if (!ok) return { ok: false, reason: "delete_failed" };
      // Post-verify: row is gone.
      const after = await getProductById(op.tenantId, op.entityId);
      if (after) return { ok: false, reason: "post_verify_failed" };
      return { ok: true, state: { exists: false } };
    }
    case "product.update": {
      if (!op.entityId) return { ok: false, reason: "missing_entity_id" };
      // Build a patch from beforeState for every changed field.
      const patch: Record<string, unknown> = {};
      for (const f of op.affectedFields) {
        const key = f as keyof typeof op.beforeState;
        const value = op.beforeState[key];
        // null + undefined both get through — the catalog layer handles
        // "unset me" semantics for nullable columns.
        patch[f] = value === undefined ? null : value;
      }
      if (Object.keys(patch).length === 0) {
        return { ok: false, reason: "no_restore_fields" };
      }
      const ok = await updateProduct(op.tenantId, op.entityId, patch);
      if (!ok) return { ok: false, reason: "update_failed" };
      return { ok: true, state: patch };
    }
    case "customer.create": {
      const key = (op.entityKey ?? {}) as { branchId?: string; phone?: string };
      if (!key.branchId || !key.phone) {
        return { ok: false, reason: "missing_entity_key" };
      }
      // Delete the wallet row the original create inserted. Dependency check
      // ran in buildRollbackPreview; we re-validate here to close the TOCTOU
      // window.
      const dep = await checkDependencies(op);
      if (dep && dep.code !== "ALREADY_REMOVED") {
        return { ok: false, reason: `dependency_blocked:${dep.code}` };
      }
      await withTenant(op.tenantId, async (tx) => {
        await tx
          .delete(customerWallets)
          .where(
            and(
              eq(customerWallets.tenantId, op.tenantId),
              eq(customerWallets.branchId, key.branchId!),
              eq(customerWallets.customerPhone, key.phone!),
            ),
          );
      });
      // Post-verify: row is gone.
      const [persisted] = await withTenant(op.tenantId, async (tx) => {
        return tx
          .select()
          .from(customerWallets)
          .where(
            and(
              eq(customerWallets.tenantId, op.tenantId),
              eq(customerWallets.branchId, key.branchId!),
              eq(customerWallets.customerPhone, key.phone!),
            ),
          );
      });
      if (persisted) {
        return { ok: false, reason: "post_verify_failed" };
      }
      return { ok: true, state: { exists: false } };
    }
    default:
      return { ok: false, reason: "unknown_operation_type" };
  }
}

/* ───────────────────────── state readers ─────────────────────────────── */

async function fetchCurrentState(
  op: OperationRecord,
): Promise<Record<string, unknown> | null> {
  if (op.entityType === "product") {
    // For product.create rollback, the "current state" is whether the row
    // still exists. Match the beforeState shape ({exists: false}).
    if (op.operationType === "product.create") {
      if (!op.entityId) return null;
      const p = await getProductById(op.tenantId, op.entityId);
      // afterState for a create is { exists: true, ... }; if the row is gone
      // the "current" is { exists: false } which drifts → concurrent_change.
      if (!p) return { exists: false };
      return { exists: true, name: p.name };
    }
    if (!op.entityId) return null;
    const p = await getProductById(op.tenantId, op.entityId);
    if (!p) return null;
    return { price: Number(p.price), quantity: p.quantity };
  }
  if (op.entityType === "customer") {
    const key = (op.entityKey ?? {}) as { branchId?: string; phone?: string };
    if (!key.branchId || !key.phone) return null;
    return withTenant(op.tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(customerWallets)
        .where(
          and(
            eq(customerWallets.tenantId, op.tenantId),
            eq(customerWallets.branchId, key.branchId!),
            eq(customerWallets.customerPhone, key.phone!),
          ),
        );
      return row ? { exists: true, name: row.customerName, phone: row.customerPhone } : null;
    });
  }
  return null;
}

async function getProductById(tenantId: string, id: string) {
  const all = await listProducts(tenantId, null);
  return all.find((p) => p.id === id) ?? null;
}

/* ───────────────────────── comparators ──────────────────────────────── */

/** Compare each watched field between `expected` (op.afterState) and
 *  `current` (fresh DB read). Returns null when everything matches; else
 *  returns the two values side-by-side for the conflict block. Exported for
 *  unit tests — the production code inside buildRollbackPreview is the only
 *  caller. */
export function diffWatchedFields(
  expected: Record<string, unknown>,
  current: Record<string, unknown>,
  watched: string[],
): { expected: Record<string, unknown>; current: Record<string, unknown> } | null {
  const e: Record<string, unknown> = {};
  const c: Record<string, unknown> = {};
  let dirty = false;
  for (const f of watched) {
    const ev = expected[f];
    const cv = current[f];
    if (!deepEq(ev, cv)) {
      dirty = true;
      e[f] = ev;
      c[f] = cv;
    }
  }
  return dirty ? { expected: e, current: c } : null;
}

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  // Shallow string/number compare is enough for our value shapes (price,
  // quantity, boolean, string). Nested objects aren't currently captured.
  return JSON.stringify(a) === JSON.stringify(b);
}

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ───────────────────────── audit ──────────────────────────────────────── */

async function writeAuditRow(opts: {
  tenantId: string;
  actorUserId: string;
  actorName: string | null;
  branchId: string | null;
  op: OperationRecord;
  restored: Record<string, unknown>;
  rollbackOperationId: string;
}): Promise<void> {
  const actionMap: Record<OperationType, string> = {
    "product.price.update": "product.rollback",
    "product.quantity.update": "product.rollback",
    "product.quantity.adjust": "product.rollback",
    "product.create": "product.rollback",
    "product.update": "product.rollback",
    "customer.create": "customer.rollback",
  };
  const action = actionMap[opts.op.operationType] ?? "ai.rollback";
  const category = opts.op.entityType === "customer" ? "customer" : "product";

  try {
    await insertActivityRow({
      tenantId: opts.tenantId,
      actorUserId: opts.actorUserId,
      actorName: opts.actorName,
      action,
      category,
      entityType: opts.op.entityType,
      entityId: opts.op.entityId ?? undefined,
      entityLabel: opts.op.entityLabel,
      branchId: opts.branchId,
      metadata: {
        via: "ai_rollback",
        originalOperationId: opts.op.id,
        rollbackOperationId: opts.rollbackOperationId,
        before: opts.op.afterState,
        after: opts.restored,
        affectedFields: opts.op.affectedFields,
      },
    });
  } catch (e) {
    // Non-fatal; the ai_operations rollback row + updated status are the
    // authoritative record. Mirrors the F5.1 contract.
    console.error("[ai/rollback] audit_insert_failed", {
      tenantId: opts.tenantId,
      operationId: opts.op.id,
      reason: e instanceof Error ? e.message : "unknown",
    });
  }
}

function readinessReason(r: RollbackReadiness): string {
  switch (r.kind) {
    case "expired":
      return "rollback window has expired";
    case "already_reverted":
      return "operation has already been rolled back";
    case "concurrent_change":
      return "record changed after the AI operation";
    case "dependency_blocked":
      return r.block.message;
    case "not_reversible":
      return "operation was recorded as non-reversible";
    case "entity_missing":
      return "target record no longer exists";
    default:
      return "unknown";
  }
}

/** Suppress unused export when `products` isn't referenced in this file path. */
void products;

/* ───────────────────────── group rollback ──────────────────────────── */

export interface GroupRollbackResult {
  groupId: string;
  reversed: number;
  conflicted: number;
  failed: number;
  reasons: Array<{ operationId: string; code: string; message: string }>;
}

/**
 * F10.1 — Roll back every reversible operation in a group.
 *
 * Order: newest-first (so dependent changes undo before their dependencies,
 * e.g. an import's price updates roll back before the row's create).
 *
 * Per-row behavior: each operation goes through the SAME per-op rollback
 * path (buildRollbackPreview → applyRestore → recordOperation → audit), so
 * concurrency + dependency checks run per row. Rows whose readiness is not
 * `ready` are counted as `conflicted` with their reason surfaced to the user.
 *
 * NEVER report full success if any row failed or conflicted.
 */
export async function executeGroupRollback(opts: {
  tenantId: string;
  groupId: string;
  actorUserId: string;
  actorName: string | null;
  conversationId: string | null;
}): Promise<GroupRollbackResult> {
  const result: GroupRollbackResult = {
    groupId: opts.groupId,
    reversed: 0,
    conflicted: 0,
    failed: 0,
    reasons: [],
  };

  // Load the group's operations (newest first).
  const { withTenant: _wt } = await import("@/lib/db");
  const { aiOperations, aiOperationGroups } = await import("@/lib/db/schema");
  const { asc, desc, eq, and } = await import("drizzle-orm");
  const { fetchOperationById } = await import("./record");

  const opRows = await _wt(opts.tenantId, async (tx) => {
    return tx
      .select({ id: aiOperations.id })
      .from(aiOperations)
      .where(
        and(
          eq(aiOperations.tenantId, opts.tenantId),
          eq(aiOperations.operationGroupId, opts.groupId),
        ),
      )
      .orderBy(desc(aiOperations.createdAt));
  });
  if (opRows.length === 0) return result;

  for (const { id } of opRows) {
    const op = await fetchOperationById({ tenantId: opts.tenantId, operationId: id });
    if (!op) {
      result.failed++;
      result.reasons.push({ operationId: id, code: "NOT_FOUND", message: "operation vanished" });
      continue;
    }
    if (op.status === "rolled_back") {
      // Already reverted — count as reversed to avoid misleading conflict counts.
      result.reversed++;
      continue;
    }
    const execRes = await executeRollback({
      op,
      actorUserId: opts.actorUserId,
      actorName: opts.actorName,
      conversationId: opts.conversationId,
    });
    if (execRes.ok) {
      result.reversed++;
      continue;
    }
    if (execRes.kind === "concurrent_change" || execRes.kind === "dependency_blocked") {
      result.conflicted++;
    } else {
      result.failed++;
    }
    result.reasons.push({ operationId: id, code: execRes.kind, message: execRes.reason });
  }

  // Update group status + counts.
  await _wt(opts.tenantId, async (tx) => {
    await tx
      .update(aiOperationGroups)
      .set({
        reversedOperations: result.reversed,
        conflictedOperations: result.conflicted,
        status: result.conflicted === 0 && result.failed === 0 ? "rolled_back" : "partially_rolled_back",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiOperationGroups.id, opts.groupId),
          eq(aiOperationGroups.tenantId, opts.tenantId),
        ),
      );
  });
  void asc;
  return result;
}
