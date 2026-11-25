import type { Locale } from "../language";
import { tr } from "../i18n";
import type {
  EditableImportColumn,
  EditableImportFieldType,
  EditableImportPreviewBlock,
  EditableImportRow,
} from "../responses";

import type { ProcessedRow } from "./adapters/types";

/**
 * F11 — Build the full editable preview block for an import session.
 *
 * This is the "advanced preview" shown in chat: every row from the file is
 * surfaced with its canonical fields, server-assigned row id, and current
 * status. The mobile client renders it as a horizontally + vertically
 * scrollable table with inline editable cells. Edits PATCH
 * /api/ai/import/update-row which re-runs adapter.validateAndResolve and
 * returns the updated row + session counts.
 *
 * ADAPTER COLUMNS — for the product adapter we currently surface the full
 * set of canonical fields the importer understands. Adding future adapters
 * (customers, employees) means supplying a per-adapter column spec; we
 * keep the dispatch here in one place so the mobile renderer stays generic.
 *
 * SAFETY — status/action are computed server-side from ProcessedRow. The
 * client cannot forge a "ready" row by sending bogus cell values; the edit
 * endpoint re-validates every write before persisting the new status.
 */

export const EDITABLE_PREVIEW_ROW_LIMIT = 500;

interface BuildOptions {
  session: {
    id: string;
    entityType: string;
    fileName: string;
    currency?: string | null;
  };
  rows: Array<ProcessedRow & { id: string }>;
  locale: Locale;
  /** Tenant category labels in display order. When provided, the editable
   *  preview turns `category` into a `choice` column so the user picks a
   *  real category instead of typing free text that won't resolve. */
  categoryLabels?: string[];
}

export function buildEditableImportPreviewBlock(
  opts: BuildOptions,
): EditableImportPreviewBlock {
  const columns = columnsForEntityType(
    opts.session.entityType,
    opts.locale,
    opts.categoryLabels,
  );
  const rows = opts.rows.map((r) => toEditableRow(r, columns));

  const counts = summarise(opts.rows);
  const readyToConfirm =
    counts.invalid === 0 &&
    counts.missing === 0 &&
    counts.ambiguous === 0 &&
    (counts.toCreate + counts.toUpdate) > 0;

  return {
    kind: "editable_import_preview",
    sessionId: opts.session.id,
    entityType: opts.session.entityType,
    fileName: opts.session.fileName,
    totalRows: opts.rows.length,
    toCreate: counts.toCreate,
    toUpdate: counts.toUpdate,
    toSkip: counts.toSkip,
    invalid: counts.invalid,
    ambiguous: counts.ambiguous,
    missing: counts.missing,
    errorCount: counts.errorCount,
    warningCount: counts.warningCount,
    columns,
    rows,
    title: tr("import.preview.title", opts.locale, { file: opts.session.fileName }),
    description: tr("import.preview.descriptionFull", opts.locale, {
      total: opts.rows.length,
      toCreate: counts.toCreate,
      toUpdate: counts.toUpdate,
      issues: counts.invalid + counts.missing + counts.ambiguous,
    }),
    readyToConfirm,
    computedAt: new Date().toISOString(),
    currency: opts.session.currency ?? undefined,
  };
}

/* ─────────────────────────── columns ──────────────────────────────────── */

function columnsForEntityType(
  entityType: string,
  locale: Locale,
  categoryLabels?: string[],
): EditableImportColumn[] {
  if (entityType === "product") return productColumns(locale, categoryLabels);
  // Unknown entity types fall back to a minimal name/sku view. When new
  // adapters land (customer, employee) add a dispatch arm here.
  return [
    { key: "name", label: tr("import.column.name", locale), type: "text", editable: true, required: true, minWidth: 180 },
  ];
}

function productColumns(
  locale: Locale,
  categoryLabels?: string[],
): EditableImportColumn[] {
  // When the tenant has categories, render `category` as a choice column so
  // the user picks from a known list instead of typing free text that may
  // not resolve. category is REQUIRED on create — the validator refuses
  // silent `categories[0]` fallback.
  const categoryCol: EditableImportColumn =
    categoryLabels && categoryLabels.length > 0
      ? {
          key: "category",
          label: tr("import.column.category", locale),
          type: "choice",
          editable: true,
          required: true,
          choices: categoryLabels,
          minWidth: 160,
        }
      : {
          key: "category",
          label: tr("import.column.category", locale),
          type: "text",
          editable: true,
          required: true,
          minWidth: 160,
        };
  return [
    { key: "name", label: tr("import.column.name", locale), type: "text", editable: true, required: true, minWidth: 200 },
    { key: "sku", label: tr("import.column.sku", locale), type: "text", editable: true, required: false, minWidth: 130 },
    { key: "brand", label: tr("import.column.brand", locale), type: "text", editable: true, required: false, minWidth: 140 },
    categoryCol,
    { key: "price", label: tr("import.column.price", locale), type: "money", editable: true, required: true, minWidth: 110 },
    { key: "costPrice", label: tr("import.column.costPrice", locale), type: "money", editable: true, required: false, minWidth: 110 },
    { key: "wholesalePrice", label: tr("import.column.wholesalePrice", locale), type: "money", editable: true, required: false, minWidth: 110 },
    { key: "quantity", label: tr("import.column.quantity", locale), type: "integer", editable: true, required: true, minWidth: 90 },
    { key: "lowStockThreshold", label: tr("import.column.lowStockThreshold", locale), type: "integer", editable: true, required: false, minWidth: 110 },
    { key: "barcode", label: tr("import.column.barcode", locale), type: "text", editable: true, required: false, minWidth: 130 },
    { key: "description", label: tr("import.column.description", locale), type: "text", editable: true, required: false, minWidth: 220 },
  ];
}

/* ─────────────────────────── rows ────────────────────────────────────── */

function toEditableRow(
  row: ProcessedRow & { id: string },
  columns: EditableImportColumn[],
): EditableImportRow {
  const cells: Record<string, string | number | null> = {};
  for (const c of columns) {
    cells[c.key] = coerceCell(row.normalised[c.key] ?? row.raw[c.key] ?? null, c.type);
  }
  const existing = extractExisting(row, columns);
  const errors = [
    ...row.errors.map((e) => e.message),
    ...row.issues.map((i) => i.message),
  ].filter((m): m is string => typeof m === "string" && m.length > 0);
  const issue = errors[0];
  return {
    rowIndex: row.rowIndex,
    rowId: row.id,
    status: row.status,
    action: row.action,
    cells,
    existing,
    issue,
    errors,
  };
}

function extractExisting(
  row: ProcessedRow,
  columns: EditableImportColumn[],
): Record<string, string | number | null> | undefined {
  if (row.action !== "update") return undefined;
  const resolution = row.resolution as { existingValues?: Record<string, unknown> };
  if (!resolution || !resolution.existingValues) return undefined;
  const existing: Record<string, string | number | null> = {};
  for (const c of columns) {
    const v = resolution.existingValues[c.key];
    if (v === undefined) continue;
    existing[c.key] = coerceCell(v, c.type);
  }
  return Object.keys(existing).length > 0 ? existing : undefined;
}

function coerceCell(
  value: unknown,
  type: EditableImportFieldType,
): string | number | null {
  if (value === null || value === undefined || value === "") return null;
  if (type === "number" || type === "money" || type === "integer") {
    const n = typeof value === "number" ? value : Number(String(value));
    if (Number.isFinite(n)) {
      return type === "integer" ? Math.trunc(n) : n;
    }
    return null;
  }
  return String(value);
}

/* ─────────────────────────── counts ──────────────────────────────────── */

export interface EditablePreviewCounts {
  toCreate: number;
  toUpdate: number;
  toSkip: number;
  invalid: number;
  ambiguous: number;
  missing: number;
  errorCount: number;
  warningCount: number;
}

export function summarise(rows: ProcessedRow[]): EditablePreviewCounts {
  const c: EditablePreviewCounts = {
    toCreate: 0,
    toUpdate: 0,
    toSkip: 0,
    invalid: 0,
    ambiguous: 0,
    missing: 0,
    errorCount: 0,
    warningCount: 0,
  };
  for (const r of rows) {
    if (r.action === "create") c.toCreate++;
    else if (r.action === "update") c.toUpdate++;
    else if (r.action === "skip") c.toSkip++;
    if (r.status === "invalid") c.invalid++;
    else if (r.status === "ambiguous") c.ambiguous++;
    else if (r.status === "missing") c.missing++;
    c.errorCount += r.errors.length;
    c.warningCount += r.issues.length;
  }
  return c;
}
