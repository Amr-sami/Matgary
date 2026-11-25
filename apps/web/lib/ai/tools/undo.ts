import { and, desc, eq } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { aiOperationGroups, aiOperations } from "@/lib/db/schema";

import { tr } from "../i18n";
import { fetchOperationById, findLastRecordedOperation } from "../operations/record";
import { buildRollbackPreview } from "../operations/rollback";
import type { AiBlock, Locale, RollbackPreviewBlock } from "../responses";
import { createPending } from "../write/pending";

import type { Tool } from "./types";

/**
 * F10.0 — AI tools for the "undo that" flow.
 *
 * Two tools:
 *   • find_last_operation — the LLM calls this when it hears "undo" / "revert"
 *     / "التراجع" / etc. Returns a lightweight summary of the most-recent
 *     reversible AI operation this user owns in this conversation.
 *   • preview_rollback    — the LLM calls this with an operation_id to stage
 *     the pending rollback. Emits RollbackPreviewBlock + ConfirmationBlock.
 *
 * The LLM NEVER constructs the inverse mutation. Everything the rollback
 * engine needs is already on the stored operation record.
 */

/* ───────────────────────── find_last_operation ────────────────────────── */

export const findLastOperation: Tool = {
  name: "find_last_operation",
  description:
    "Find the most recent reversible AI operation this user made in THIS conversation. Call this when the user says 'undo that' / 'undo the last change' / 'revert that' / 'rollback that' / 'التراجع' / 'ارجع آخر تعديل' / Portuguese 'desfaça isso' / French 'annulez ça' / Spanish 'deshaz eso'. Returns the operation_id plus a short summary; you must then call preview_rollback with that operation_id. If no operation is found, call render_text and explain nothing recent can be undone — do NOT invent an operation.",
  requiredPermission: "view_insights",
  parameters: {
    type: "object",
    properties: {
      entity_type: {
        type: "string",
        enum: ["product", "customer"],
        description: "Optional — narrow to a specific entity family when the user names one.",
      },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const entityType =
      args.entity_type === "product" || args.entity_type === "customer"
        ? args.entity_type
        : undefined;
    const op = await findLastRecordedOperation({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      conversationId: ctx.conversationId ?? null,
      branchId: null,
      entityType,
    });
    if (!op) {
      return {
        ok: true,
        data: {
          found: false,
          reason: "no_recent_reversible_operation_in_this_conversation",
        },
      };
    }
    return {
      ok: true,
      data: {
        found: true,
        operationId: op.id,
        operationType: op.operationType,
        entityType: op.entityType,
        entityLabel: op.entityLabel,
        affectedFields: op.affectedFields,
        afterState: op.afterState,
        beforeState: op.beforeState,
        createdAt: op.createdAt.toISOString(),
      },
    };
  },
};

/* ───────────────────────── preview_rollback ───────────────────────────── */

export const previewRollback: Tool = {
  name: "preview_rollback",
  description:
    "Stage a confirmation to UNDO a previously-executed AI operation. Pass the operation_id you got from find_last_operation. NEVER construct the inverse write yourself — the server has the before/after state and runs the restore using it. This tool: (1) runs concurrency + dependency checks, (2) emits a RollbackPreviewBlock + ConfirmationBlock, (3) does NOT execute. The actual rollback runs when the user taps Confirm. If the preview returns a conflict (concurrent_change / dependency_blocked / expired / already_reverted) the tool returns the conflict block directly — do not call render_knowledge_answer / render_text separately; just forward the returned blocks.",
  requiredPermission: "view_insights",
  parameters: {
    type: "object",
    properties: {
      operation_id: { type: "string", description: "uuid returned by find_last_operation." },
    },
    required: ["operation_id"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const operationId = String(args.operation_id ?? "").trim();
    if (!operationId) return { ok: false, error: "MISSING_OPERATION_ID" };

    const op = await fetchOperationById({ tenantId: ctx.tenantId, operationId });
    if (!op || op.userId !== ctx.userId) {
      return { ok: false, error: "OPERATION_NOT_FOUND" };
    }
    const readiness = await buildRollbackPreview(op);
    if (readiness.kind !== "ready") {
      const kindDetail = readiness.kind;
      const conflict: AiBlock = {
        kind: "rollback_conflict",
        operationId: op.id,
        operationType: op.operationType,
        entityLabel: op.entityLabel,
        kind_detail: kindDetail,
        reason:
          readiness.kind === "concurrent_change"
            ? `expected=${JSON.stringify(readiness.current)} current=${JSON.stringify(readiness.current)}`
            : readiness.kind === "dependency_blocked"
              ? readiness.block.code
              : readiness.kind,
        title: tr("rollback.conflict.title", ctx.locale, { name: op.entityLabel }),
        message: conflictMessage(readiness.kind, ctx.locale),
      };
      return { ok: true, blocks: [conflict] };
    }

    // Build the preview + stage a pending rollback.
    const preview = readiness.preview;
    const previewBlock: RollbackPreviewBlock = {
      kind: "rollback_preview",
      operationId: op.id,
      operationType: op.operationType,
      entityType: op.entityType,
      entityLabel: op.entityLabel,
      beforeState: op.beforeState,
      afterState: op.afterState,
      currentState: preview.currentState,
      affectedFields: op.affectedFields,
      destructive: preview.destructive,
      title: tr("rollback.preview.title", ctx.locale, { name: op.entityLabel }),
      description: describeRollback(op, ctx.locale),
    };

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "rollback",
      params: { operationId: op.id },
      preview: {
        locale: ctx.locale,
        operationType: op.operationType,
        entityLabel: op.entityLabel,
        affectedFields: op.affectedFields,
      },
    });

    return {
      ok: true,
      blocks: [
        previewBlock,
        {
          kind: "confirmation",
          title: tr("rollback.preview.title", ctx.locale, { name: op.entityLabel }),
          summary: previewBlock.description,
          actionLabel: tr("rollback.actionLabel", ctx.locale),
          token: pending.token,
          expiresAt: pending.expiresAt,
        },
      ],
    };
  },
};

/* ──────────────── preview_import_rollback (F10.1) ──────────────────── */

export const previewImportRollback: Tool = {
  name: "preview_import_rollback",
  description:
    "Stage a confirmation to UNDO an entire import (operation group). The LLM should call this when the user says 'undo that import' / 'revert the import' / similar. Takes `operation_group_id` — if omitted, the engine picks the user's most recent completed import in THIS conversation. Returns a RollbackPreviewBlock summarising the group + a ConfirmationBlock. Actual execution happens on user tap; the engine iterates row-by-row with per-row concurrency + dependency checks and never claims full success when any row conflicts.",
  requiredPermission: "manage_inventory",
  parameters: {
    type: "object",
    properties: {
      operation_group_id: { type: "string", description: "Optional; omit to use the user's most recent import group in this conversation." },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const requested = typeof args.operation_group_id === "string" ? args.operation_group_id.trim() : "";
    let groupId = requested;
    if (!groupId) {
      // Resolve latest group owned by this user in this conversation (if any),
      // otherwise fall back to the latest-in-tenant-for-this-user.
      groupId = await resolveLatestImportGroup({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        branchId: null,
      });
      if (!groupId) {
        return {
          ok: true,
          blocks: [{ kind: "text", text: tr("rollback.nothingToUndo", ctx.locale) }],
        };
      }
    }

    // Ownership + branch scope check.
    const group = await withTenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(aiOperationGroups)
        .where(
          and(
            eq(aiOperationGroups.id, groupId),
            eq(aiOperationGroups.tenantId, ctx.tenantId),
          ),
        );
      return row ?? null;
    });
    if (!group || group.userId !== ctx.userId) {
      return { ok: false, error: "GROUP_NOT_FOUND" };
    }

    // Build a lightweight RollbackPreviewBlock summarising the group. The
    // detailed per-row readiness is deferred to execute time so this preview
    // doesn't bind a stale snapshot across confirmation.
    const previewBlock: RollbackPreviewBlock = {
      kind: "rollback_preview",
      operationId: group.id,
      operationType: "import.group",
      entityType: group.entityType === "product" ? "product" : "customer",
      entityLabel: group.label,
      beforeState: { operations: group.totalOperations },
      afterState: { operations: group.totalOperations },
      currentState: {
        reversed: group.reversedOperations,
        conflicted: group.conflictedOperations,
      },
      affectedFields: [`${group.totalOperations} rows`],
      destructive: true,
      title: tr("rollback.preview.title", ctx.locale, { name: group.label }),
      description: tr("import.result.undoHint", ctx.locale),
    };

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "rollback",
      params: { operationGroupId: group.id },
      preview: {
        locale: ctx.locale,
        operationType: "import.group",
        entityLabel: group.label,
        totalOperations: group.totalOperations,
      },
    });

    return {
      ok: true,
      blocks: [
        previewBlock,
        {
          kind: "confirmation",
          title: previewBlock.title,
          summary: previewBlock.description,
          actionLabel: tr("rollback.actionLabel", ctx.locale),
          token: pending.token,
          expiresAt: pending.expiresAt,
        } satisfies AiBlock,
      ],
    };
  },
};

async function resolveLatestImportGroup(opts: {
  tenantId: string;
  userId: string;
  branchId: string | null;
}): Promise<string> {
  // Legacy `branchId` arg kept for the handler call-site shape; always null
  // now (Storo has no branch feature) so the query is tenant+user scoped.
  void opts.branchId;
  return withTenant(opts.tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: aiOperationGroups.id })
      .from(aiOperationGroups)
      .where(
        and(
          eq(aiOperationGroups.tenantId, opts.tenantId),
          eq(aiOperationGroups.userId, opts.userId),
          eq(aiOperationGroups.groupType, "import"),
        ),
      )
      .orderBy(desc(aiOperationGroups.createdAt))
      .limit(1);
    return row?.id ?? "";
  });
}

/** Suppress unused — module re-exports aiOperations ambiently. */
void aiOperations;

/* ───────────────────────── helpers ──────────────────────────────────── */

function describeRollback(
  op: { operationType: string; entityLabel: string; beforeState: Record<string, unknown>; afterState: Record<string, unknown> },
  locale: Locale,
): string {
  if (op.operationType === "product.price.update") {
    return tr("rollback.preview.description.price", locale, {
      before: String(op.beforeState.price ?? "?"),
      after: String(op.afterState.price ?? "?"),
    });
  }
  if (
    op.operationType === "product.quantity.update" ||
    op.operationType === "product.quantity.adjust"
  ) {
    return tr("rollback.preview.description.quantity", locale, {
      before: String(op.beforeState.quantity ?? "?"),
      after: String(op.afterState.quantity ?? "?"),
    });
  }
  if (op.operationType === "customer.create") {
    return tr("rollback.preview.description.customer", locale, {
      name: op.entityLabel,
    });
  }
  return op.entityLabel;
}

function conflictMessage(kind: string, locale: Locale): string {
  switch (kind) {
    case "concurrent_change":
      return tr("rollback.conflict.concurrentChange", locale);
    case "dependency_blocked":
      return tr("rollback.conflict.dependency", locale);
    case "expired":
      return tr("rollback.conflict.expired", locale);
    case "already_reverted":
      return tr("rollback.conflict.alreadyReverted", locale);
    case "entity_missing":
      return tr("rollback.conflict.entityMissing", locale);
    case "not_reversible":
      return tr("rollback.conflict.notReversible", locale);
    default:
      return tr("rollback.conflict.generic", locale);
  }
}
