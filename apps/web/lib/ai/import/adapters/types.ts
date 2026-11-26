import type { Locale } from "../../language";
import type { ParsedSheet } from "../parse";

/**
 * F10.1 — Entity adapter contract.
 *
 * The import engine is entity-agnostic: it parses the file, delegates to
 * `classify()` to recognise what the sheet represents, then uses the chosen
 * adapter for every downstream step. Adding customers / employees in later
 * waves is a matter of writing a new ImportEntityAdapter — no engine edits.
 */

export type EntityType = "product" | "customer" | "employee" | "supplier";

/** Row-level verdicts, kept small so the JSON payloads don't explode. */
export type RowStatus =
  | "valid"     // all fields present + valid + resolves cleanly
  | "invalid"   // deterministic validation failure (negative price, duplicate SKU in file…)
  | "ambiguous" // resolver returned multiple plausible candidates
  | "missing"   // required field is empty
  | "ready"     // validated + resolved + ready to execute
  | "imported"  // executor wrote the DB row and recorded the ai_operation
  | "failed"    // executor tried + failed
  | "skipped";  // user asked to skip, or correction set action='skip'

export type RowAction = "create" | "update" | "skip" | "none";

export interface RowError {
  field: string;
  code: string;
  message: string;
}

export interface RowIssue {
  /** Machine-readable kind: "missing_field" | "ambiguous_brand" | … */
  kind: string;
  field: string;
  message: string;
  /** For ambiguity — the candidate list the resolver produced. */
  candidates?: Array<Record<string, unknown>>;
}

export interface ClassifyResult {
  entityType: EntityType | null;
  /** 0..1 — the engine only proceeds past 0.5. */
  confidence: number;
  /** Diagnostic — the mapping the classifier would recommend. */
  fieldMappingHint: Record<string, string>;
  /** Fields the sheet appears to cover (canonical names). */
  detectedFields: string[];
}

export interface AdapterContext {
  tenantId: string;
  userId: string;
  branchId: string | null;
  locale: Locale;
}

/** Row-level validation + resolution output, persisted to ai_import_rows. */
export interface ProcessedRow {
  rowIndex: number;
  status: RowStatus;
  action: RowAction;
  /** Original raw cells. */
  raw: Record<string, string>;
  /** Canonical-field payload ready for the executor. */
  normalised: Record<string, unknown>;
  /** { existingId: uuid | null, existingValues: {…} } when action=update. */
  resolution: Record<string, unknown>;
  errors: RowError[];
  issues: RowIssue[];
}

/** A correction the user provides conversationally, validated server-side
 *  before being applied to the session. Shape is deliberately open so new
 *  entity types can introduce their own correction kinds — the engine
 *  dispatches by kind. */
export interface Correction {
  kind:
    | "set_field_mapping"       // { fromHeader, toCanonicalField }
    | "set_default"             // { field, value }  — applies to rows missing `field`
    | "skip_rows"               // { rowIndexes: number[] } OR { where: { field, value } }
    | "resolve_entity"          // { field, pickedValue, forHeaderValue }
    | "set_action_for_row"      // { rowIndex, action }
    | "set_row_field";          // { rowIndex, field, value }
  payload: Record<string, unknown>;
}

export interface ImportEntityAdapter {
  readonly entityType: EntityType;
  /** Human-readable canonical field names the adapter understands. */
  readonly canonicalFields: ReadonlyArray<string>;
  /** Fields that CANNOT be missing when action="create". */
  readonly requiredForCreate: ReadonlyArray<string>;

  /**
   * Inspect sheet headers and return a confidence score for this entity
   * type + the best-guess column-to-field mapping.
   */
  classify(sheet: ParsedSheet): Promise<ClassifyResult> | ClassifyResult;

  /**
   * Map one raw row → normalised fields using the chosen column mapping.
   * Pure — no DB access. Downstream `validateAndResolve` does the DB work.
   */
  mapRow(
    raw: Record<string, string>,
    fieldMapping: Record<string, string>,
  ): Record<string, unknown>;

  /**
   * Validate + resolve one row against the live catalog. Returns the full
   * row-state including action, resolution, errors, issues.
   */
  validateAndResolve(opts: {
    rowIndex: number;
    raw: Record<string, string>;
    normalised: Record<string, unknown>;
    ctx: AdapterContext;
    /** SKUs the adapter has already seen in THIS file — the adapter uses
     *  this to detect intra-file duplicate SKUs. */
    seenSkus: Set<string>;
  }): Promise<ProcessedRow>;

  /**
   * Build a user-visible preview summary (for ImportPreviewBlock). The engine
   * calls this after ALL rows have been processed so the summary reflects the
   * final post-correction state.
   */
  buildPreview(rows: ProcessedRow[]): {
    totalRows: number;
    toCreate: number;
    toUpdate: number;
    toSkip: number;
    invalid: number;
    ambiguous: number;
    missing: number;
    /** A small sample for the mobile block (first N rows per category). */
    sampleCreate: ProcessedRow[];
    sampleUpdate: ProcessedRow[];
    sampleIssues: ProcessedRow[];
  };

  /**
   * Execute ONE row — either create or update via the existing repo helpers.
   * Returns { ok, entityId, entityLabel, beforeState, afterState, affectedFields }
   * so the executor can record a reversible ai_operations row.
   */
  executeRow(opts: {
    row: ProcessedRow;
    ctx: AdapterContext;
  }): Promise<
    | {
        ok: true;
        action: "create" | "update";
        entityId: string;
        entityLabel: string;
        beforeState: Record<string, unknown>;
        afterState: Record<string, unknown>;
        affectedFields: string[];
      }
    | { ok: false; reason: string }
  >;
}

/** Apply a validated correction to the parsed rows. Lives on the adapter so
 *  entity-specific semantics (e.g. "skip rows missing wholesale price")
 *  can be encoded per type. Pure w.r.t. DB: uses in-memory session state. */
export function applyCorrectionToRows(
  correction: Correction,
  rows: ProcessedRow[],
): ProcessedRow[] {
  switch (correction.kind) {
    case "skip_rows": {
      const indexes = Array.isArray(correction.payload.rowIndexes)
        ? (correction.payload.rowIndexes as number[])
        : [];
      return rows.map((r) =>
        indexes.includes(r.rowIndex) ? { ...r, status: "skipped", action: "skip" } : r,
      );
    }
    case "set_action_for_row": {
      const idx = Number(correction.payload.rowIndex);
      const next = String(correction.payload.action);
      return rows.map((r) =>
        r.rowIndex === idx ? { ...r, action: next as RowAction } : r,
      );
    }
    case "set_default": {
      // Handled per-adapter — this generic branch just surfaces the correction
      // as metadata the adapter picks up on re-validation.
      return rows;
    }
    case "set_row_field": {
      const idx = Number(correction.payload.rowIndex);
      const field = String(correction.payload.field);
      const value = correction.payload.value;
      return rows.map((r) =>
        r.rowIndex === idx
          ? { ...r, normalised: { ...r.normalised, [field]: value } }
          : r,
      );
    }
    default:
      return rows;
  }
}
