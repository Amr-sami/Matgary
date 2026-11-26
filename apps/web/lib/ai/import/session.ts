import { createHash } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import {
  aiImportRows,
  aiImportSessions,
  type AiImportSessionRow,
} from "@/lib/db/schema";

import type { Locale } from "../language";

import { getAdapter } from "./adapters/products";
import type {
  AdapterContext,
  ImportEntityAdapter,
  ProcessedRow,
} from "./adapters/types";
import { parseBuffer, type ParsedSheet } from "./parse";

/**
 * F10.1 — Import session service.
 *
 * Responsibilities:
 *   • Create or dedupe a session for a given (tenant, file_hash, entity_type).
 *   • Run the parse → classify → map → validate pipeline on upload.
 *   • Persist every row in `ai_import_rows` so conversational correction
 *     + confirm can resume across chat turns.
 *   • Expose read + mutation helpers for the AI tools.
 */

const SESSION_TTL_HOURS = 24;

export interface IngestInput {
  tenantId: string;
  userId: string;
  branchId: string | null;
  conversationId: string | null;
  locale: Locale;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  /** Optional hint; when absent the engine auto-classifies. */
  entityType?: "product";
}

export interface IngestResult {
  sessionId: string;
  status: AiImportSessionRow["status"];
  entityType: string;
  reusedExisting: boolean;
  counts: {
    rowCount: number;
    valid: number;
    invalid: number;
    ambiguous: number;
    missing: number;
  };
  fieldMapping: Record<string, string>;
  classifier: { confidence: number; detectedFields: string[] };
}

export class ImportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ImportError";
    this.code = code;
  }
}

/* ───────────────────────── ingest ──────────────────────────────────── */

export async function ingestFile(input: IngestInput): Promise<IngestResult> {
  // 1. Parse (validates MIME + size + extension up front).
  let sheet: ParsedSheet;
  try {
    sheet = parseBuffer({
      buffer: input.buffer,
      fileName: input.fileName,
      mimeType: input.mimeType,
    });
  } catch (e) {
    throw new ImportError(
      (e as { code?: string }).code ?? "PARSE_FAILED",
      e instanceof Error ? e.message : String(e),
    );
  }

  // 2. Hash the file bytes for dedupe.
  const fileHash = sha256(input.buffer);

  // 3. Classify. For F10.1 we only have a product adapter — the hint is
  //    always "product" and classification confidence gates acceptance.
  const entityType = input.entityType ?? "product";
  const adapter = getAdapter(entityType);
  const classifier = await adapter.classify(sheet);
  if (!classifier.entityType || classifier.confidence < 0.5) {
    throw new ImportError(
      "ENTITY_CLASSIFICATION_FAILED",
      `Could not recognise "${input.fileName}" as a ${entityType} sheet (confidence=${classifier.confidence.toFixed(2)})`,
    );
  }

  // 4. Dedupe by (tenant, file_hash, entity_type). If an existing session
  //    is reusable, return it instead of creating a duplicate.
  const existing = await findExistingSession({
    tenantId: input.tenantId,
    fileHash,
    entityType,
  });
  if (existing) {
    return {
      sessionId: existing.id,
      status: existing.status,
      entityType: existing.entityType,
      reusedExisting: true,
      counts: {
        rowCount: existing.rowCount,
        valid: existing.validCount,
        invalid: existing.invalidCount,
        ambiguous: existing.ambiguousCount,
        missing: existing.missingCount,
      },
      fieldMapping: existing.fieldMapping,
      classifier: {
        confidence: classifier.confidence,
        detectedFields: classifier.detectedFields,
      },
    };
  }

  // 5. Create the session row.
  const session = await createSession({
    tenantId: input.tenantId,
    userId: input.userId,
    branchId: input.branchId,
    conversationId: input.conversationId,
    entityType,
    fileName: sheet.fileName,
    mimeType: input.mimeType,
    fileHash,
    fileSize: input.buffer.length,
    fieldMapping: classifier.fieldMappingHint,
  });

  // 6. Map + validate every row. One pass; results persist in ai_import_rows.
  const seenSkus = new Set<string>();
  const ctx: AdapterContext = {
    tenantId: input.tenantId,
    userId: input.userId,
    branchId: input.branchId,
    locale: input.locale,
  };
  const processed: ProcessedRow[] = [];
  for (let i = 0; i < sheet.rows.length; i++) {
    const raw = sheet.rows[i]!;
    const normalised = adapter.mapRow(raw, classifier.fieldMappingHint);
    const row = await adapter.validateAndResolve({
      rowIndex: i + 1,
      raw,
      normalised,
      ctx,
      seenSkus,
    });
    processed.push(row);
  }

  // 7. Persist rows + update session counts.
  await persistRows(session.id, input.tenantId, processed);
  const counts = summarise(processed);
  await updateSessionStatus({
    tenantId: input.tenantId,
    sessionId: session.id,
    status: computeStatus(counts),
    counts,
  });

  return {
    sessionId: session.id,
    status: computeStatus(counts),
    entityType,
    reusedExisting: false,
    counts,
    fieldMapping: classifier.fieldMappingHint,
    classifier: {
      confidence: classifier.confidence,
      detectedFields: classifier.detectedFields,
    },
  };
}

/* ───────────────────────── reads ──────────────────────────────────── */

export async function loadSession(opts: {
  tenantId: string;
  sessionId: string;
}): Promise<AiImportSessionRow | null> {
  return withTenant(opts.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(aiImportSessions)
      .where(
        and(
          eq(aiImportSessions.id, opts.sessionId),
          eq(aiImportSessions.tenantId, opts.tenantId),
        ),
      );
    return row ?? null;
  });
}

export async function loadRows(opts: {
  tenantId: string;
  sessionId: string;
}): Promise<ProcessedRow[]> {
  const rows = await loadRowsWithIds(opts);
  // Drop id for the historical callers that don't need it (execute loop).
  return rows.map(({ id: _id, ...rest }) => rest);
}

/** Same as loadRows() but keeps the ai_import_rows.id so the editable preview
 *  can target an exact row for inline edits. */
export async function loadRowsWithIds(opts: {
  tenantId: string;
  sessionId: string;
}): Promise<Array<ProcessedRow & { id: string }>> {
  const rows = await withTenant(opts.tenantId, async (tx) => {
    return tx
      .select()
      .from(aiImportRows)
      .where(
        and(
          eq(aiImportRows.tenantId, opts.tenantId),
          eq(aiImportRows.importSessionId, opts.sessionId),
        ),
      )
      .orderBy(asc(aiImportRows.rowIndex));
  });
  return rows.map((r) => ({
    id: r.id,
    rowIndex: r.rowIndex,
    status: r.status as ProcessedRow["status"],
    action: r.action as ProcessedRow["action"],
    raw: r.raw,
    normalised: r.normalised,
    resolution: r.resolution,
    errors: r.errors as unknown as ProcessedRow["errors"],
    issues: r.issues as unknown as ProcessedRow["issues"],
  }));
}

/* ───────────────────────── mutations ──────────────────────────────── */

export async function replaceRows(opts: {
  tenantId: string;
  sessionId: string;
  rows: ProcessedRow[];
}): Promise<void> {
  await withTenant(opts.tenantId, async (tx) => {
    await tx
      .delete(aiImportRows)
      .where(
        and(
          eq(aiImportRows.tenantId, opts.tenantId),
          eq(aiImportRows.importSessionId, opts.sessionId),
        ),
      );
    if (opts.rows.length > 0) {
      await tx.insert(aiImportRows).values(
        opts.rows.map((r) => ({
          tenantId: opts.tenantId,
          importSessionId: opts.sessionId,
          rowIndex: r.rowIndex,
          status: r.status,
          action: r.action,
          raw: r.raw,
          normalised: r.normalised,
          resolution: r.resolution,
          errors: r.errors as unknown as Array<Record<string, unknown>>,
          issues: r.issues as unknown as Array<Record<string, unknown>>,
        })),
      );
    }
  });
  const counts = summarise(opts.rows);
  await updateSessionStatus({
    tenantId: opts.tenantId,
    sessionId: opts.sessionId,
    status: computeStatus(counts),
    counts,
  });
}

export async function updateSessionStatus(opts: {
  tenantId: string;
  sessionId: string;
  status: AiImportSessionRow["status"];
  statusDetail?: string;
  counts?: IngestResult["counts"];
  operationGroupId?: string;
}): Promise<void> {
  await withTenant(opts.tenantId, async (tx) => {
    const set: Record<string, unknown> = {
      status: opts.status,
      updatedAt: new Date(),
    };
    if (opts.statusDetail !== undefined) set.statusDetail = opts.statusDetail;
    if (opts.counts) {
      set.rowCount = opts.counts.rowCount;
      set.validCount = opts.counts.valid;
      set.invalidCount = opts.counts.invalid;
      set.ambiguousCount = opts.counts.ambiguous;
      set.missingCount = opts.counts.missing;
    }
    if (opts.operationGroupId) set.operationGroupId = opts.operationGroupId;
    await tx
      .update(aiImportSessions)
      .set(set)
      .where(
        and(
          eq(aiImportSessions.id, opts.sessionId),
          eq(aiImportSessions.tenantId, opts.tenantId),
        ),
      );
  });
}

/* ───────────────────────── internals ──────────────────────────────── */

async function findExistingSession(opts: {
  tenantId: string;
  fileHash: string;
  entityType: string;
}): Promise<AiImportSessionRow | null> {
  return withTenant(opts.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(aiImportSessions)
      .where(
        and(
          eq(aiImportSessions.tenantId, opts.tenantId),
          eq(aiImportSessions.fileHash, opts.fileHash),
          eq(aiImportSessions.entityType, opts.entityType),
        ),
      );
    return row ?? null;
  });
}

async function createSession(opts: {
  tenantId: string;
  userId: string;
  branchId: string | null;
  conversationId: string | null;
  entityType: string;
  fileName: string;
  mimeType: string;
  fileHash: string;
  fileSize: number;
  fieldMapping: Record<string, string>;
}): Promise<AiImportSessionRow> {
  return withTenant(opts.tenantId, async (tx) => {
    const [row] = await tx
      .insert(aiImportSessions)
      .values({
        tenantId: opts.tenantId,
        userId: opts.userId,
        branchId: opts.branchId,
        conversationId: opts.conversationId,
        entityType: opts.entityType,
        fileName: opts.fileName,
        mimeType: opts.mimeType,
        fileHash: opts.fileHash,
        fileSize: opts.fileSize,
        status: "parsing",
        fieldMapping: opts.fieldMapping,
      })
      .returning();
    return row!;
  });
}

async function persistRows(
  sessionId: string,
  tenantId: string,
  rows: ProcessedRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await withTenant(tenantId, async (tx) => {
    await tx.insert(aiImportRows).values(
      rows.map((r) => ({
        tenantId,
        importSessionId: sessionId,
        rowIndex: r.rowIndex,
        status: r.status,
        action: r.action,
        raw: r.raw,
        normalised: r.normalised,
        resolution: r.resolution,
        errors: r.errors as unknown as Array<Record<string, unknown>>,
        issues: r.issues as unknown as Array<Record<string, unknown>>,
      })),
    );
  });
}

function summarise(rows: ProcessedRow[]): IngestResult["counts"] {
  const c = { rowCount: rows.length, valid: 0, invalid: 0, ambiguous: 0, missing: 0 };
  for (const r of rows) {
    if (r.status === "invalid") c.invalid++;
    else if (r.status === "ambiguous") c.ambiguous++;
    else if (r.status === "missing") c.missing++;
    else if (r.status === "ready" || r.status === "valid") c.valid++;
  }
  return c;
}

function computeStatus(counts: IngestResult["counts"]): AiImportSessionRow["status"] {
  if (counts.ambiguous > 0 || counts.missing > 0 || counts.invalid > 0) {
    return "needs_input";
  }
  if (counts.valid === 0) return "needs_input";
  return "ready_for_preview";
}

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

/* Keep the module exportable pathway for tests. */
export { getAdapter };
export type { ImportEntityAdapter, ProcessedRow };
export { SESSION_TTL_HOURS };
