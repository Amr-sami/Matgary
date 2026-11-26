import { and, eq } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import {
  aiImportRows,
  aiOperationGroups,
  type AiPendingActionRow,
} from "@/lib/db/schema";

import { tr } from "../i18n";
import type { Locale } from "../language";
import { recordOperation } from "../operations/record";
import type { OperationType } from "../operations/types";
import type { AiBlock, ImportResultBlock } from "../responses";

import { getAdapter } from "./adapters/products";
import type { ProcessedRow } from "./adapters/types";
import { loadRows, loadSession, updateSessionStatus } from "./session";

/**
 * F10.1 — Import execution.
 *
 * Called by the F5 executor when a pending action with `action="import"` is
 * consumed. Workflow:
 *   1. Load session + rows.
 *   2. Create an ai_operation_groups row ("Import {file}").
 *   3. For each row with action in {create, update}:
 *        - adapter.executeRow → creates/updates via existing repo helpers
 *        - record an ai_operations row linking to the group
 *        - mark ai_import_rows.status = imported | failed + operation_id
 *   4. Update session status (completed | partially_completed) + counts.
 *   5. Emit ImportResultBlock.
 *
 * SAFETY:
 *   • Session ownership re-checked (tenant + user) before writing.
 *   • One operation group per import → F10.0 rollback can revert the whole
 *     import by iterating operations in the group.
 *   • Per-row failures are isolated: one failing INSERT doesn't block the rest.
 *   • The user NEVER sees "success" when any row failed — the result block
 *     reports {created, updated, skipped, failed} exactly.
 */

export interface ExecuteImportInput {
  pendingRow: AiPendingActionRow;
  actorUserId: string;
  actorName: string | null;
  conversationId: string | null;
}

export interface ExecuteImportResult {
  ok: boolean;
  blocks: AiBlock[];
  debug: {
    sessionId?: string;
    operationGroupId?: string;
    counts?: { created: number; updated: number; skipped: number; failed: number };
    reason?: string;
  };
}

export async function executeImport(input: ExecuteImportInput): Promise<ExecuteImportResult> {
  const { pendingRow } = input;
  const sessionId = String((pendingRow.params as Record<string, unknown>).importSessionId ?? "");
  if (!sessionId) {
    return failed("MISSING_SESSION_ID", pendingRow);
  }

  const session = await loadSession({ tenantId: pendingRow.tenantId, sessionId });
  if (!session) return failed("SESSION_NOT_FOUND", pendingRow);
  if (session.userId !== pendingRow.userId) {
    return failed("OWNERSHIP_MISMATCH", pendingRow);
  }

  const rows = await loadRows({ tenantId: pendingRow.tenantId, sessionId });
  const adapter = getAdapter(session.entityType);
  const execRows = rows.filter((r) => r.action === "create" || r.action === "update");

  // 1. Create the operation group.
  const groupId = await createOperationGroup({
    tenantId: pendingRow.tenantId,
    userId: pendingRow.userId,
    branchId: pendingRow.branchId,
    entityType: session.entityType,
    fileName: session.fileName,
    totalOperations: execRows.length,
  });
  await updateSessionStatus({
    tenantId: pendingRow.tenantId,
    sessionId,
    status: "importing",
    operationGroupId: groupId,
  });

  // 2. Execute row by row.
  let created = 0;
  let updated = 0;
  let failed_ = 0;
  const skipped = rows.filter((r) => r.status === "skipped" || r.action === "skip").length;
  const failures: Array<{ rowIndex: number; reason: string }> = [];

  for (const row of execRows) {
    const res = await adapter.executeRow({
      row,
      ctx: {
        tenantId: pendingRow.tenantId,
        userId: pendingRow.userId,
        branchId: pendingRow.branchId,
        locale: (pendingRow.preview as { locale?: unknown }).locale as Locale,
      },
    });
    if (!res.ok) {
      failed_++;
      failures.push({ rowIndex: row.rowIndex, reason: res.reason });
      await markImportRow(pendingRow.tenantId, sessionId, row.rowIndex, "failed", null);
      continue;
    }
    if (res.action === "create") created++;
    else updated++;

    // Record a reversible ai_operations row that joins the group.
    const op = await recordOperation({
      tenantId: pendingRow.tenantId,
      userId: pendingRow.userId,
      branchId: pendingRow.branchId,
      conversationId: input.conversationId,
      operationType: toOperationType(res.action, res.affectedFields),
      pendingActionId: pendingRow.id,
      operationGroupId: groupId,
      entityType: "product",
      entityId: res.entityId,
      entityLabel: res.entityLabel,
      beforeState: res.beforeState,
      afterState: res.afterState,
      affectedFields: res.affectedFields,
      actorName: input.actorName,
      metadata: {
        kind: "import",
        importSessionId: sessionId,
        rowIndex: row.rowIndex,
      },
    });
    await markImportRow(pendingRow.tenantId, sessionId, row.rowIndex, "imported", op.id);
  }

  // 3. Update group totals + session.
  const sessionFinalStatus =
    failed_ === 0 ? "completed" : created + updated === 0 ? "failed" : "partially_completed";
  await updateOperationGroup({
    tenantId: pendingRow.tenantId,
    groupId,
    totalOperations: execRows.length,
    status:
      sessionFinalStatus === "completed"
        ? "completed"
        : sessionFinalStatus === "failed"
          ? "failed"
          : "partially_completed",
  });
  await updateSessionStatus({
    tenantId: pendingRow.tenantId,
    sessionId,
    status: sessionFinalStatus as "completed" | "failed" | "partially_completed",
  });

  const locale = pickLocale(pendingRow);
  const resultBlock: ImportResultBlock = {
    kind: "import_result",
    sessionId,
    operationGroupId: groupId,
    fileName: session.fileName,
    entityType: session.entityType,
    created,
    updated,
    skipped,
    failed: failed_,
    failures: failures.slice(0, 10),
    title: tr("import.result.title", locale, { file: session.fileName }),
    message: tr("import.result.message", locale, { created, updated, skipped, failed: failed_ }),
  };

  return {
    ok: failed_ === 0,
    blocks: [resultBlock],
    debug: {
      sessionId,
      operationGroupId: groupId,
      counts: { created, updated, skipped, failed: failed_ },
    },
  };
}

/* ───────────────────────── helpers ──────────────────────────────── */

function toOperationType(
  action: "create" | "update",
  affectedFields: string[],
): OperationType {
  if (action === "create") return "product.create";
  if (affectedFields.includes("quantity")) return "product.quantity.update";
  return "product.price.update";
}

function pickLocale(row: AiPendingActionRow): Locale {
  const preview = row.preview as { locale?: unknown };
  const localeRaw = typeof preview.locale === "string" ? preview.locale : "en";
  return (["ar", "en", "pt", "fr", "es"].includes(localeRaw) ? localeRaw : "en") as Locale;
}

async function createOperationGroup(opts: {
  tenantId: string;
  userId: string;
  branchId: string | null;
  entityType: string;
  fileName: string;
  totalOperations: number;
}): Promise<string> {
  return withTenant(opts.tenantId, async (tx) => {
    const [row] = await tx
      .insert(aiOperationGroups)
      .values({
        tenantId: opts.tenantId,
        userId: opts.userId,
        branchId: opts.branchId,
        groupType: "import",
        entityType: opts.entityType,
        label: `Import ${opts.fileName}`,
        status: "in_progress",
        totalOperations: opts.totalOperations,
      })
      .returning({ id: aiOperationGroups.id });
    return row!.id;
  });
}

async function updateOperationGroup(opts: {
  tenantId: string;
  groupId: string;
  totalOperations: number;
  status: string;
}): Promise<void> {
  await withTenant(opts.tenantId, async (tx) => {
    await tx
      .update(aiOperationGroups)
      .set({
        totalOperations: opts.totalOperations,
        status: opts.status,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiOperationGroups.id, opts.groupId),
          eq(aiOperationGroups.tenantId, opts.tenantId),
        ),
      );
  });
}

async function markImportRow(
  tenantId: string,
  sessionId: string,
  rowIndex: number,
  status: "imported" | "failed",
  operationId: string | null,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const set: Record<string, unknown> = { status, updatedAt: new Date() };
    if (operationId) set.operationId = operationId;
    await tx
      .update(aiImportRows)
      .set(set)
      .where(
        and(
          eq(aiImportRows.tenantId, tenantId),
          eq(aiImportRows.importSessionId, sessionId),
          eq(aiImportRows.rowIndex, rowIndex),
        ),
      );
  });
}

function failed(reason: string, row: AiPendingActionRow): ExecuteImportResult {
  const locale = pickLocale(row);
  return {
    ok: false,
    blocks: [
      {
        kind: "text",
        text:
          reason === "SESSION_NOT_FOUND"
            ? tr("import.sessionMissing", locale)
            : reason,
      },
    ],
    debug: { reason },
  };
}
