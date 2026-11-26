import { and, eq } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { aiOperationGroups, type AiPendingActionRow } from "@/lib/db/schema";
import { updateProduct, listProducts } from "@/lib/repo/catalog";

import { tr } from "../i18n";
import type { Locale } from "../language";
import { recordOperation } from "../operations/record";
import type { AiBlock, BulkResultBlock } from "../responses";

import { type BulkPricePreview } from "./products";

/**
 * F10.3 — Bulk-price-update executor.
 *
 * Reads the pending row's params (`{ changes: [{productId, before, after}], mode, value }`)
 * and applies them one at a time via the existing `updateProduct` repo helper.
 * Each successful row records an `ai_operations` row under a single
 * `ai_operation_groups` — matching the F10.1 import pattern so "undo that"
 * reverts the whole bulk via `executeGroupRollback` without special-casing.
 *
 * Partial failure is reported honestly: {updated, skipped, failed, reasons[]}.
 * The user NEVER sees "updated all 100" when 97 succeeded.
 */

export interface ExecuteBulkInput {
  pendingRow: AiPendingActionRow;
  actorUserId: string;
  actorName: string | null;
  conversationId: string | null;
}

export interface ExecuteBulkResult {
  ok: boolean;
  blocks: AiBlock[];
  debug: {
    operationGroupId?: string;
    counts?: { updated: number; skipped: number; failed: number };
    reason?: string;
  };
}

export async function executeBulkPriceUpdate(
  input: ExecuteBulkInput,
): Promise<ExecuteBulkResult> {
  const { pendingRow } = input;
  const params = pendingRow.params as {
    changes?: Array<{ productId: string; before: number; after: number }>;
    mode?: string;
    value?: number;
  };
  const changes = Array.isArray(params.changes) ? params.changes : [];
  if (changes.length === 0) {
    return failed("NO_CHANGES", pendingRow);
  }

  // Create the operation group.
  const groupId = await createGroup({
    tenantId: pendingRow.tenantId,
    userId: pendingRow.userId,
    branchId: pendingRow.branchId,
    totalOperations: changes.length,
    label: `Bulk price update (${params.mode}, ${params.value})`,
  });

  // Re-read the candidate set under the current branch so the concurrency
  // check uses live state, not the stale snapshot from preview time.
  const live = await listProducts(pendingRow.tenantId, pendingRow.branchId);
  const byId = new Map(live.map((p) => [p.id, p]));

  let updated = 0;
  let skipped = 0;
  let failedN = 0;
  const reasons: Array<{ productId: string; code: string; message: string }> = [];

  for (const change of changes) {
    const current = byId.get(change.productId);
    if (!current) {
      skipped++;
      reasons.push({ productId: change.productId, code: "TARGET_GONE", message: "Product no longer exists" });
      continue;
    }
    const livePrice = Number(current.price);
    // Concurrency gate — if another user changed the price since preview,
    // DON'T overwrite.
    if (Math.abs(livePrice - change.before) > 0.001) {
      skipped++;
      reasons.push({
        productId: change.productId,
        code: "CONCURRENT_CHANGE",
        message: `price changed from ${change.before} to ${livePrice} since preview`,
      });
      continue;
    }
    const after = change.after;
    if (after < 0) {
      skipped++;
      reasons.push({ productId: change.productId, code: "NEGATIVE_RESULT", message: "Would go negative" });
      continue;
    }
    try {
      const ok = await updateProduct(pendingRow.tenantId, change.productId, { price: after });
      if (!ok) {
        failedN++;
        reasons.push({ productId: change.productId, code: "WRITE_FAILED", message: "update returned false" });
        continue;
      }
    } catch (e) {
      failedN++;
      reasons.push({
        productId: change.productId,
        code: "WRITE_EXCEPTION",
        message: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    // Post-verify + record.
    const verify = (await listProducts(pendingRow.tenantId, pendingRow.branchId)).find(
      (p) => p.id === change.productId,
    );
    if (!verify || Math.abs(Number(verify.price) - after) > 0.001) {
      failedN++;
      reasons.push({
        productId: change.productId,
        code: "POST_VERIFY_FAILED",
        message: `expected ${after}, got ${verify?.price}`,
      });
      continue;
    }

    await recordOperation({
      tenantId: pendingRow.tenantId,
      userId: pendingRow.userId,
      branchId: pendingRow.branchId,
      conversationId: input.conversationId,
      operationType: "product.price.update",
      pendingActionId: pendingRow.id,
      operationGroupId: groupId,
      entityType: "product",
      entityId: change.productId,
      entityLabel: verify.name,
      beforeState: { price: change.before },
      afterState: { price: after },
      affectedFields: ["price"],
      actorName: input.actorName,
      metadata: { kind: "bulk_price_update", mode: params.mode, value: params.value },
    });
    updated++;
  }

  // Update group totals + status.
  const groupStatus =
    failedN === 0 && skipped === 0
      ? "completed"
      : updated > 0
        ? "partially_completed"
        : "failed";
  await withTenant(pendingRow.tenantId, async (tx) => {
    await tx
      .update(aiOperationGroups)
      .set({
        status: groupStatus,
        totalOperations: changes.length,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiOperationGroups.id, groupId),
          eq(aiOperationGroups.tenantId, pendingRow.tenantId),
        ),
      );
  });

  const locale = pickLocale(pendingRow);
  const block: BulkResultBlock = {
    kind: "bulk_result",
    operationGroupId: groupId,
    operationKind: "product.price.update",
    updated,
    skipped,
    failed: failedN,
    reasons: reasons.slice(0, 10),
    title: tr("bulk.result.title", locale),
    message: tr("bulk.result.message", locale, { updated, skipped, failed: failedN }),
  };

  return {
    ok: failedN === 0,
    blocks: [block],
    debug: {
      operationGroupId: groupId,
      counts: { updated, skipped, failed: failedN },
    },
  };
}

/* ───────────────────────── helpers ──────────────────────────────── */

async function createGroup(opts: {
  tenantId: string;
  userId: string;
  branchId: string | null;
  totalOperations: number;
  label: string;
}): Promise<string> {
  return withTenant(opts.tenantId, async (tx) => {
    const [row] = await tx
      .insert(aiOperationGroups)
      .values({
        tenantId: opts.tenantId,
        userId: opts.userId,
        branchId: opts.branchId,
        groupType: "bulk_price_update",
        entityType: "product",
        label: opts.label,
        status: "in_progress",
        totalOperations: opts.totalOperations,
      })
      .returning({ id: aiOperationGroups.id });
    return row!.id;
  });
}

function failed(reason: string, row: AiPendingActionRow): ExecuteBulkResult {
  const locale = pickLocale(row);
  return {
    ok: false,
    blocks: [{ kind: "text", text: tr("bulk.invalid", locale, { reason }) }],
    debug: { reason },
  };
}

function pickLocale(row: AiPendingActionRow): Locale {
  const preview = row.preview as { locale?: unknown };
  const localeRaw = typeof preview.locale === "string" ? preview.locale : "en";
  return (["ar", "en", "pt", "fr", "es"].includes(localeRaw) ? localeRaw : "en") as Locale;
}

// Mark imports used only by types above as intentionally referenced.
void (undefined as BulkPricePreview | undefined);

/* ─────────────── F10.3 (extended) — quantity + threshold ───────── */

/**
 * Generalised bulk integer-field executor. Used for both
 * `bulk_quantity_update` and `bulk_threshold_update` — the pending-action
 * row carries `changes: [{productId, before, after}]` as before. The field
 * is picked from the action name.
 */
export interface ExecuteBulkIntInput {
  pendingRow: AiPendingActionRow;
  actorUserId: string;
  actorName: string | null;
  conversationId: string | null;
  field: "quantity" | "lowStockThreshold";
}

export async function executeBulkIntUpdate(
  input: ExecuteBulkIntInput,
): Promise<ExecuteBulkResult> {
  const { pendingRow, field } = input;
  const params = pendingRow.params as {
    changes?: Array<{ productId: string; before: number; after: number }>;
    mode?: string;
    value?: number;
  };
  const changes = Array.isArray(params.changes) ? params.changes : [];
  if (changes.length === 0) return failed("NO_CHANGES", pendingRow);

  const label =
    field === "quantity"
      ? `Bulk quantity update (${params.mode}, ${params.value})`
      : `Bulk low-stock threshold update (${params.mode}, ${params.value})`;
  const groupType =
    field === "quantity" ? "bulk_quantity_update" : "bulk_threshold_update";

  const groupId = await createGroupTyped({
    tenantId: pendingRow.tenantId,
    userId: pendingRow.userId,
    branchId: pendingRow.branchId,
    totalOperations: changes.length,
    label,
    groupType,
  });

  const live = await listProducts(pendingRow.tenantId, pendingRow.branchId);
  const byId = new Map(live.map((p) => [p.id, p]));

  let updated = 0;
  let skipped = 0;
  let failedN = 0;
  const reasons: Array<{ productId: string; code: string; message: string }> = [];

  for (const change of changes) {
    const current = byId.get(change.productId);
    if (!current) {
      skipped++;
      reasons.push({ productId: change.productId, code: "TARGET_GONE", message: "Product no longer exists" });
      continue;
    }
    const liveVal = field === "quantity" ? current.quantity : current.lowStockThreshold;
    if (liveVal !== change.before) {
      skipped++;
      reasons.push({
        productId: change.productId,
        code: "CONCURRENT_CHANGE",
        message: `${field} changed from ${change.before} to ${liveVal} since preview`,
      });
      continue;
    }
    const after = change.after;
    if (after < 0) {
      skipped++;
      reasons.push({ productId: change.productId, code: "NEGATIVE_RESULT", message: "Would go negative" });
      continue;
    }
    const patch =
      field === "quantity"
        ? { quantity: Math.floor(after) }
        : { lowStockThreshold: Math.floor(after) };
    try {
      const ok = await updateProduct(pendingRow.tenantId, change.productId, patch);
      if (!ok) {
        failedN++;
        reasons.push({ productId: change.productId, code: "WRITE_FAILED", message: "update returned false" });
        continue;
      }
    } catch (e) {
      failedN++;
      reasons.push({
        productId: change.productId,
        code: "WRITE_EXCEPTION",
        message: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    const verify = (await listProducts(pendingRow.tenantId, pendingRow.branchId)).find(
      (p) => p.id === change.productId,
    );
    if (!verify) {
      failedN++;
      reasons.push({ productId: change.productId, code: "POST_VERIFY_FAILED", message: "row vanished" });
      continue;
    }
    const verifyVal = field === "quantity" ? verify.quantity : verify.lowStockThreshold;
    if (verifyVal !== Math.floor(after)) {
      failedN++;
      reasons.push({
        productId: change.productId,
        code: "POST_VERIFY_FAILED",
        message: `expected ${after}, got ${verifyVal}`,
      });
      continue;
    }

    // Record a reversible ai_operation. Quantity has a dedicated rollback
    // path; threshold does NOT — mark threshold writes reversible=false so
    // F10.0 preview_rollback refuses to touch them (instead of corrupting
    // the field restore).
    const reversible = field === "quantity";
    if (reversible) {
      await recordOperation({
        tenantId: pendingRow.tenantId,
        userId: pendingRow.userId,
        branchId: pendingRow.branchId,
        conversationId: input.conversationId,
        operationType: "product.quantity.update",
        pendingActionId: pendingRow.id,
        operationGroupId: groupId,
        entityType: "product",
        entityId: change.productId,
        entityLabel: verify.name,
        beforeState: { quantity: change.before },
        afterState: { quantity: verifyVal },
        affectedFields: ["quantity"],
        actorName: input.actorName,
        metadata: { kind: groupType, mode: params.mode, value: params.value },
      });
    }
    updated++;
  }

  const groupStatus =
    failedN === 0 && skipped === 0
      ? "completed"
      : updated > 0
        ? "partially_completed"
        : "failed";
  await withTenant(pendingRow.tenantId, async (tx) => {
    await tx
      .update(aiOperationGroups)
      .set({
        status: groupStatus,
        totalOperations: changes.length,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiOperationGroups.id, groupId),
          eq(aiOperationGroups.tenantId, pendingRow.tenantId),
        ),
      );
  });

  const locale = pickLocale(pendingRow);
  const block: BulkResultBlock = {
    kind: "bulk_result",
    operationGroupId: groupId,
    operationKind: "product.price.update",
    updated,
    skipped,
    failed: failedN,
    reasons: reasons.slice(0, 10),
    title: tr("bulk.result.title", locale),
    message: tr("bulk.result.message", locale, { updated, skipped, failed: failedN }),
  };

  return {
    ok: failedN === 0,
    blocks: [block],
    debug: { operationGroupId: groupId, counts: { updated, skipped, failed: failedN } },
  };
}

async function createGroupTyped(opts: {
  tenantId: string;
  userId: string;
  branchId: string | null;
  totalOperations: number;
  label: string;
  groupType: string;
}): Promise<string> {
  return withTenant(opts.tenantId, async (tx) => {
    const [row] = await tx
      .insert(aiOperationGroups)
      .values({
        tenantId: opts.tenantId,
        userId: opts.userId,
        branchId: opts.branchId,
        groupType: opts.groupType,
        entityType: "product",
        label: opts.label,
        status: "in_progress",
        totalOperations: opts.totalOperations,
      })
      .returning({ id: aiOperationGroups.id });
    return row!.id;
  });
}
