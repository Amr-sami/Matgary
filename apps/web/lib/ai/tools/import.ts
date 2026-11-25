import { listCategories } from "@/lib/repo/catalog";
import { tr } from "../i18n";
import {
  applyCorrectionToRows,
  type Correction,
} from "../import/adapters/types";
import { getAdapter } from "../import/adapters/products";
import {
  buildEditableImportPreviewBlock,
  EDITABLE_PREVIEW_ROW_LIMIT,
} from "../import/editable-preview";
import {
  loadRows,
  loadRowsWithIds,
  loadSession,
  replaceRows,
  updateSessionStatus,
} from "../import/session";
import { revalidateRows } from "../import/revalidate";
import type {
  AdapterContext,
  ProcessedRow,
} from "../import/adapters/types";
import type {
  AiBlock,
  ImportPreviewBlock,
  ImportPreviewRowSummary,
  ImportQuestionBlock,
  Locale,
} from "../responses";
import { createPending } from "../write/pending";

import type { Tool } from "./types";

/**
 * F10.1 — AI tools for the import flow.
 *
 * Three tools:
 *   • inspect_import  — read the session + rows and emit a question/preview
 *                       the user can act on.
 *   • apply_import_correction — accept a structured correction (skip rows,
 *                       set a default value, map a header differently) and
 *                       re-validate.
 *   • preview_import  — once the session is `ready_for_preview`, stage an
 *                       F5 pending action with action="import" for confirm.
 *
 * SAFETY:
 *   • The LLM cannot provide tenantId/userId/branchId — those come from
 *     ctx. Every session lookup re-checks ownership (same tenant + user).
 *   • Corrections are validated server-side: unknown kinds are rejected.
 *   • File contents are DATA. The LLM is told explicitly in the system
 *     prompt not to execute instructions embedded in imported rows.
 */

/* ───────────────────────── inspect_import ─────────────────────────── */

export const inspectImport: Tool = {
  name: "inspect_import",
  description:
    "Fetch the state of an import session (counts, issues, sample rows). Call this when the user references an import ('import this file', 'the import I just started'). Returns either an ImportQuestionBlock (when the session needs clarification) or an ImportPreviewBlock (when it's ready). Does NOT execute anything. The LLM must NEVER provide tenantId/userId — they come from the server context.",
  requiredPermission: "manage_inventory",
  parameters: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "uuid returned by /api/ai/import/upload." },
    },
    required: ["session_id"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const sessionId = String(args.session_id ?? "").trim();
    if (!sessionId) return { ok: false, error: "MISSING_SESSION_ID" };
    const session = await loadSession({ tenantId: ctx.tenantId, sessionId });
    if (!session || session.userId !== ctx.userId) {
      return {
        ok: true,
        blocks: [
          { kind: "text", text: tr("import.sessionMissing", ctx.locale) },
        ],
      };
    }
    const rowsWithIds = await loadRowsWithIds({ tenantId: ctx.tenantId, sessionId });
    const rows: ProcessedRow[] = rowsWithIds.map(({ id: _id, ...rest }) => rest);
    const adapter = getAdapter(session.entityType);
    const preview = adapter.buildPreview(rows);

    // When the session still needs input, emit a question block.
    if (session.status === "needs_input") {
      const questionBlock = buildQuestionBlock({
        sessionId,
        locale: ctx.locale,
        rows,
      });
      return { ok: true, blocks: [questionBlock] };
    }

    // Prefer the full editable preview — mobile can inspect + edit every row.
    // Fall back to the summary block for pathologically huge imports.
    if (rowsWithIds.length <= EDITABLE_PREVIEW_ROW_LIMIT) {
      const categoryLabels = (
        await listCategories(ctx.tenantId, null)
      ).map((c) => c.label);
      const editableBlock = buildEditableImportPreviewBlock({
        session: {
          id: sessionId,
          entityType: session.entityType,
          fileName: session.fileName,
          currency: null,
        },
        rows: rowsWithIds,
        locale: ctx.locale,
        categoryLabels,
      });
      return { ok: true, blocks: [editableBlock] };
    }

    // Fallback: legacy summary block for huge imports.
    const previewBlock: ImportPreviewBlock = {
      kind: "import_preview",
      sessionId,
      entityType: session.entityType,
      fileName: session.fileName,
      totalRows: preview.totalRows,
      toCreate: preview.toCreate,
      toUpdate: preview.toUpdate,
      toSkip: preview.toSkip,
      invalid: preview.invalid,
      ambiguous: preview.ambiguous,
      missing: preview.missing,
      sampleCreate: preview.sampleCreate.map(summariseRow),
      sampleUpdate: preview.sampleUpdate.map(summariseRow),
      sampleIssues: preview.sampleIssues.map((r) => ({
        rowIndex: r.rowIndex,
        status: r.status,
        issue: r.errors[0]?.message ?? r.issues[0]?.message ?? r.status,
      })),
      title: tr("import.preview.title", ctx.locale, { file: session.fileName }),
      description: tr("import.preview.description", ctx.locale, {
        total: preview.totalRows,
        toCreate: preview.toCreate,
        toUpdate: preview.toUpdate,
        issues: preview.invalid + preview.missing + preview.ambiguous,
      }),
    };
    return { ok: true, blocks: [previewBlock] };
  },
};

/* ──────────────────── apply_import_correction ──────────────────────── */

export const applyImportCorrection: Tool = {
  name: "apply_import_correction",
  description:
    "Apply a structured correction to an in-flight import session. Supported kinds: 'skip_rows' (payload: {rowIndexes: number[]}), 'set_action_for_row' (payload: {rowIndex: number, action: 'create'|'update'|'skip'}), 'set_row_field' (payload: {rowIndex: number, field: string, value: unknown}). The server re-validates the resulting rows and updates the session. Call inspect_import afterwards to see the new preview/question. Do NOT use this to write ERP data directly — it only mutates the pending import session.",
  requiredPermission: "manage_inventory",
  parameters: {
    type: "object",
    properties: {
      session_id: { type: "string" },
      correction: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "skip_rows",
              "set_action_for_row",
              "set_row_field",
              "set_default",
              "set_field_mapping",
              "resolve_entity",
            ],
          },
          payload: { type: "object" },
        },
        required: ["kind", "payload"],
        additionalProperties: false,
      },
    },
    required: ["session_id", "correction"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const sessionId = String(args.session_id ?? "").trim();
    if (!sessionId) return { ok: false, error: "MISSING_SESSION_ID" };
    const raw = args.correction as { kind?: string; payload?: Record<string, unknown> } | undefined;
    if (!raw || typeof raw.kind !== "string" || !raw.payload) {
      return { ok: false, error: "INVALID_CORRECTION" };
    }
    const session = await loadSession({ tenantId: ctx.tenantId, sessionId });
    if (!session || session.userId !== ctx.userId) {
      return { ok: false, error: "SESSION_NOT_FOUND" };
    }
    const correction: Correction = {
      kind: raw.kind as Correction["kind"],
      payload: raw.payload,
    };
    const rows = await loadRows({ tenantId: ctx.tenantId, sessionId });
    const mutated = applyCorrectionToRows(correction, rows);

    // F11 — set_row_field edits normalised cells but doesn't re-run the
    // adapter validator, so the row's status/action stay stuck at the
    // pre-edit verdict. Revalidate the touched rows so the preview reflects
    // the real post-edit state (e.g. a renamed SKU may now match a different
    // existing product, flipping action from create → update).
    let touchedIndexes: Set<number> | undefined;
    if (correction.kind === "set_row_field" || correction.kind === "set_action_for_row") {
      const idx = Number(correction.payload.rowIndex);
      if (Number.isFinite(idx)) touchedIndexes = new Set([idx]);
    } else if (correction.kind === "skip_rows") {
      const list = Array.isArray(correction.payload.rowIndexes)
        ? (correction.payload.rowIndexes as number[])
        : [];
      // skip_rows doesn't need DB revalidation (status/action are set
      // directly), so skip the round-trip.
      touchedIndexes = new Set();
      void list;
    }
    const adapterCtx: AdapterContext = {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      locale: ctx.locale,
    };
    const revalidated =
      touchedIndexes && touchedIndexes.size > 0
        ? await revalidateRows({
            entityType: session.entityType,
            rows: mutated,
            ctx: adapterCtx,
            rowIndexes: touchedIndexes,
          })
        : mutated;
    await replaceRows({ tenantId: ctx.tenantId, sessionId, rows: revalidated });
    return {
      ok: true,
      data: {
        sessionId,
        appliedKind: correction.kind,
        counts: summariseRows(revalidated),
      },
    };
  },
};

/* ───────────────────────── preview_import ─────────────────────────── */

export const previewImport: Tool = {
  name: "preview_import",
  description:
    "Stage the F5 confirmation to EXECUTE an import. Returns an ImportPreviewBlock + a ConfirmationBlock whose token the user taps to run the import. The session MUST be in `ready_for_preview` state (no missing/ambiguous/invalid rows), otherwise this tool returns an ImportQuestionBlock instead. Execution happens ONLY when the user confirms — never here.",
  requiredPermission: "manage_inventory",
  parameters: {
    type: "object",
    properties: {
      session_id: { type: "string" },
    },
    required: ["session_id"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const sessionId = String(args.session_id ?? "").trim();
    if (!sessionId) return { ok: false, error: "MISSING_SESSION_ID" };
    const session = await loadSession({ tenantId: ctx.tenantId, sessionId });
    if (!session || session.userId !== ctx.userId) {
      return { ok: false, error: "SESSION_NOT_FOUND" };
    }
    const rowsWithIds = await loadRowsWithIds({ tenantId: ctx.tenantId, sessionId });
    const rows: ProcessedRow[] = rowsWithIds.map(({ id: _id, ...rest }) => rest);
    const adapter = getAdapter(session.entityType);
    const preview = adapter.buildPreview(rows);

    if (preview.invalid + preview.missing + preview.ambiguous > 0) {
      // Not ready — surface the question block instead of staging a token.
      const questionBlock = buildQuestionBlock({
        sessionId,
        locale: ctx.locale,
        rows,
      });
      return { ok: true, blocks: [questionBlock] };
    }

    // Mark the session as awaiting_confirmation + stage the F5 pending row.
    await updateSessionStatus({
      tenantId: ctx.tenantId,
      sessionId,
      status: "awaiting_confirmation",
    });
    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: session.branchId,
      action: "import",
      params: { importSessionId: sessionId },
      preview: {
        locale: ctx.locale,
        entityType: session.entityType,
        fileName: session.fileName,
        counts: {
          toCreate: preview.toCreate,
          toUpdate: preview.toUpdate,
          toSkip: preview.toSkip,
        },
      },
    });

    // Full editable preview + confirmation. The user sees every row and the
    // confirmation token in one turn; the confirmation's HMAC covers only the
    // session_id, so edits applied afterwards are picked up at execute time.
    const title = tr("import.preview.title", ctx.locale, { file: session.fileName });
    if (rowsWithIds.length <= EDITABLE_PREVIEW_ROW_LIMIT) {
      const categoryLabels = (
        await listCategories(ctx.tenantId, null)
      ).map((c) => c.label);
      const editableBlock = buildEditableImportPreviewBlock({
        session: {
          id: sessionId,
          entityType: session.entityType,
          fileName: session.fileName,
          currency: null,
        },
        rows: rowsWithIds,
        locale: ctx.locale,
        categoryLabels,
      });
      return {
        ok: true,
        blocks: [
          editableBlock,
          {
            kind: "confirmation",
            title,
            summary: editableBlock.description,
            actionLabel: tr("import.preview.actionLabel", ctx.locale),
            token: pending.token,
            expiresAt: pending.expiresAt,
          } satisfies AiBlock,
        ],
      };
    }

    // Fallback: legacy summary block for huge imports.
    const previewBlock: ImportPreviewBlock = {
      kind: "import_preview",
      sessionId,
      entityType: session.entityType,
      fileName: session.fileName,
      totalRows: preview.totalRows,
      toCreate: preview.toCreate,
      toUpdate: preview.toUpdate,
      toSkip: preview.toSkip,
      invalid: preview.invalid,
      ambiguous: preview.ambiguous,
      missing: preview.missing,
      sampleCreate: preview.sampleCreate.map(summariseRow),
      sampleUpdate: preview.sampleUpdate.map(summariseRow),
      sampleIssues: [],
      title,
      description: tr("import.preview.description", ctx.locale, {
        total: preview.totalRows,
        toCreate: preview.toCreate,
        toUpdate: preview.toUpdate,
        issues: 0,
      }),
    };
    return {
      ok: true,
      blocks: [
        previewBlock,
        {
          kind: "confirmation",
          title: previewBlock.title,
          summary: previewBlock.description,
          actionLabel: tr("import.preview.actionLabel", ctx.locale),
          token: pending.token,
          expiresAt: pending.expiresAt,
        } satisfies AiBlock,
      ],
    };
  },
};

/* ───────────────────────── helpers ──────────────────────────────── */

function summariseRow(r: {
  rowIndex: number;
  action: string;
  normalised: Record<string, unknown>;
  resolution: Record<string, unknown>;
}): ImportPreviewRowSummary {
  const n = r.normalised;
  const label =
    typeof n.name === "string"
      ? n.name
      : typeof n.sku === "string"
        ? n.sku
        : `row ${r.rowIndex}`;
  const changes: Record<string, { before?: unknown; after?: unknown }> = {};
  if (r.action === "update" && (r.resolution as { existingValues?: Record<string, unknown> }).existingValues) {
    const ev = (r.resolution as { existingValues: Record<string, unknown> }).existingValues;
    if (typeof n.price === "number") {
      changes.price = { before: Number(ev.price), after: n.price };
    }
    if (typeof n.quantity === "number") {
      changes.quantity = { before: ev.quantity, after: n.quantity };
    }
  }
  return {
    rowIndex: r.rowIndex,
    action: r.action as "create" | "update" | "skip",
    entityLabel: label,
    changes: Object.keys(changes).length > 0 ? changes : undefined,
  };
}

function summariseRows(rows: Array<{ status: string }>): Record<string, number> {
  const c: Record<string, number> = { valid: 0, invalid: 0, ambiguous: 0, missing: 0, ready: 0, skipped: 0 };
  for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
  return c;
}

function buildQuestionBlock(opts: {
  sessionId: string;
  locale: Locale;
  rows: Array<{
    rowIndex: number;
    status: string;
    issues: Array<{ kind?: string; field?: string; message?: string }>;
    errors: Array<{ field?: string; code?: string; message?: string }>;
  }>;
}): ImportQuestionBlock {
  const missingRows = opts.rows.filter((r) => r.status === "missing");
  const ambiguousRows = opts.rows.filter((r) => r.status === "ambiguous");
  const invalidRows = opts.rows.filter((r) => r.status === "invalid");

  const questions: ImportQuestionBlock["questions"] = [];
  if (missingRows.length > 0) {
    // Group by the first missing field across those rows.
    const byField = new Map<string, number[]>();
    for (const r of missingRows) {
      const field = String(r.issues[0]?.field ?? "unknown");
      const arr = byField.get(field) ?? [];
      arr.push(r.rowIndex);
      byField.set(field, arr);
    }
    for (const [field, idxs] of byField.entries()) {
      questions.push({
        kind: "missing_field",
        message:
          field === "wholesalePrice"
            ? tr("import.question.missingWholesale", opts.locale, { n: idxs.length })
            : `${idxs.length} rows are missing ${field}.`,
        affectedRows: idxs,
        field,
        suggestedActions: ["skip", "set_default"],
      });
    }
  }
  for (const r of ambiguousRows) {
    questions.push({
      kind: "ambiguous_field",
      message: String(r.issues[0]?.message ?? "Row is ambiguous"),
      affectedRows: [r.rowIndex],
      field: String(r.issues[0]?.field ?? ""),
    });
  }
  for (const r of invalidRows) {
    questions.push({
      kind: "action_for_row",
      message: String(r.errors[0]?.message ?? "Row is invalid"),
      affectedRows: [r.rowIndex],
      field: String(r.errors[0]?.field ?? ""),
      suggestedActions: ["skip"],
    });
  }

  return {
    kind: "import_question",
    sessionId: opts.sessionId,
    title: tr("import.question.title", opts.locale),
    questions,
  };
}
