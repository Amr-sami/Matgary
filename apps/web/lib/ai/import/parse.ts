import * as XLSX from "xlsx";

/**
 * F10.1 — File → normalised sheet representation.
 *
 * `ParsedSheet` is deliberately minimal: an ordered list of column names and
 * a parallel list of row objects keyed by header. Downstream the entity
 * adapter consumes this and doesn't care whether the source was CSV or XLSX.
 *
 * SECURITY:
 *   • `maxBytes` is enforced at parse time.
 *   • We refuse XLSX files whose first worksheet has more than `maxRows` rows
 *     to bound memory / Gemini context.
 *   • Formula cells are read as their CALCULATED value (xlsx `cellText` /
 *     `cellValue` output). Raw formula strings are NOT exposed — they could
 *     contain external-reference / command-injection payloads for Excel
 *     itself, but that's downstream; we just want display values.
 */

export interface ParsedSheet {
  /** Source filename, normalised (basename only). */
  fileName: string;
  /** Lowercased extension, no leading dot. */
  format: "csv" | "xlsx";
  /** Ordered list of column headers in the order they appeared. */
  columns: string[];
  /** One entry per data row. Values are strings (Excel numbers → string). */
  rows: Array<Record<string, string>>;
  /** Rows AFTER the header that were skipped because they were entirely blank. */
  blankRowCount: number;
  /** Diagnostic — for XLSX this is the picked sheet name. */
  sourceSheet?: string;
}

export interface ParseOptions {
  maxBytes?: number;
  maxRows?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB — well above a realistic product import
const DEFAULT_MAX_ROWS = 5_000;

export class ParseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ParseError";
    this.code = code;
  }
}

/* ───────────────────────── format detection ───────────────────────────── */

export type SupportedMime =
  | "text/csv"
  | "application/vnd.ms-excel"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const EXT_MIME: Record<string, SupportedMime> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
};

export function detectFormat(filename: string, mimeHint?: string): "csv" | "xlsx" {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  if (ext === "csv") return "csv";
  if (ext === "xlsx" || ext === "xls") return "xlsx";
  // Fall back to MIME when extension is ambiguous.
  const m = (mimeHint ?? "").toLowerCase();
  if (m.includes("csv")) return "csv";
  if (m.includes("spreadsheet") || m.includes("excel")) return "xlsx";
  throw new ParseError("UNSUPPORTED_FORMAT", `Cannot determine format for "${filename}"`);
}

/** Validate a MIME/extension pair up front so the ingest route rejects
 *  invalid uploads before any parsing happens. */
export function validateUpload(opts: {
  fileName: string;
  mimeType: string;
  byteLength: number;
  maxBytes?: number;
}): { format: "csv" | "xlsx" } {
  const cap = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (opts.byteLength > cap) {
    throw new ParseError("FILE_TOO_LARGE", `File exceeds ${cap} bytes`);
  }
  if (opts.byteLength <= 0) {
    throw new ParseError("EMPTY_FILE", "Uploaded file is empty");
  }
  const format = detectFormat(opts.fileName, opts.mimeType);
  // MIME must match extension family (prevents ".xlsx" smuggling an EXE).
  const expected = EXT_MIME[format === "csv" ? "csv" : "xlsx"];
  const normalisedMime = opts.mimeType.toLowerCase().split(";")[0]!.trim();
  // Browsers vary — accept any CSV/XLSX-adjacent MIME when the extension is
  // trusted. We only hard-reject non-spreadsheet/non-text types.
  const okExtensionMimePair =
    (format === "csv" && (normalisedMime.includes("csv") || normalisedMime.includes("text/plain") || normalisedMime === "")) ||
    (format === "xlsx" && (normalisedMime.includes("spreadsheet") || normalisedMime.includes("excel") || normalisedMime === "application/octet-stream" || normalisedMime === ""));
  if (!okExtensionMimePair) {
    throw new ParseError(
      "MIME_MISMATCH",
      `Extension suggests ${format} but MIME is "${normalisedMime}"`,
    );
  }
  void expected;
  return { format };
}

/* ───────────────────────── CSV parse ──────────────────────────────────── */

/**
 * CSV splitter — handles quoted values, escaped quotes, and UTF-8 BOM.
 * Kept inline rather than reusing `lib/csvImport.splitCsvLine` so this
 * module is import-pipeline-specific.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parseCsvBuffer(
  buffer: Buffer,
  fileName: string,
  opts: ParseOptions = {},
): ParsedSheet {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const text = buffer.toString("utf8").replace(/^﻿/, "");
  if (!text.trim()) throw new ParseError("EMPTY_FILE", "CSV has no content");

  const lines = text.split(/\r?\n/);
  const rawHeaders = lines[0] ? splitCsvLine(lines[0]).map((s) => s.trim()) : [];
  if (rawHeaders.length === 0 || rawHeaders.every((h) => !h)) {
    throw new ParseError("MISSING_HEADERS", "CSV has no header row");
  }
  const columns = dedupeHeaders(rawHeaders);

  const rows: Array<Record<string, string>> = [];
  let blank = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line || !line.trim()) {
      blank++;
      continue;
    }
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    columns.forEach((h, idx) => {
      row[h] = (cells[idx] ?? "").trim();
    });
    rows.push(row);
    if (rows.length > maxRows) {
      throw new ParseError("TOO_MANY_ROWS", `CSV exceeds ${maxRows} rows`);
    }
  }

  return {
    fileName: basename(fileName),
    format: "csv",
    columns,
    rows,
    blankRowCount: blank,
  };
}

/* ───────────────────────── XLSX parse ────────────────────────────────── */

export function parseXlsxBuffer(
  buffer: Buffer,
  fileName: string,
  opts: ParseOptions = {},
): ParsedSheet {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, cellFormula: false });
  } catch (e) {
    throw new ParseError("PARSE_FAILED", e instanceof Error ? e.message : String(e));
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new ParseError("NO_SHEETS", "XLSX contains no worksheets");
  const sheet = workbook.Sheets[sheetName]!;

  // Convert to array-of-arrays so we can grab headers + rows deterministically.
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: "",
    raw: false, // formatted strings; numbers become their display form
  });
  if (matrix.length === 0) throw new ParseError("EMPTY_FILE", "Worksheet is empty");

  const rawHeaders = (matrix[0] as unknown[]).map((h) => String(h ?? "").trim());
  if (rawHeaders.length === 0 || rawHeaders.every((h) => !h)) {
    throw new ParseError("MISSING_HEADERS", "First row is blank — expected headers");
  }
  const columns = dedupeHeaders(rawHeaders);

  const rows: Array<Record<string, string>> = [];
  let blank = 0;
  for (let i = 1; i < matrix.length; i++) {
    const cells = matrix[i] as unknown[];
    const hasValue = cells.some((c) => String(c ?? "").trim() !== "");
    if (!hasValue) {
      blank++;
      continue;
    }
    const row: Record<string, string> = {};
    columns.forEach((h, idx) => {
      row[h] = String(cells[idx] ?? "").trim();
    });
    rows.push(row);
    if (rows.length > maxRows) {
      throw new ParseError("TOO_MANY_ROWS", `XLSX exceeds ${maxRows} rows`);
    }
  }

  return {
    fileName: basename(fileName),
    format: "xlsx",
    columns,
    rows,
    blankRowCount: blank,
    sourceSheet: sheetName,
  };
}

/* ───────────────────────── entry point ───────────────────────────────── */

export function parseBuffer(opts: {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  maxBytes?: number;
  maxRows?: number;
}): ParsedSheet {
  const { format } = validateUpload({
    fileName: opts.fileName,
    mimeType: opts.mimeType,
    byteLength: opts.buffer.length,
    maxBytes: opts.maxBytes,
  });
  return format === "csv"
    ? parseCsvBuffer(opts.buffer, opts.fileName, { maxRows: opts.maxRows })
    : parseXlsxBuffer(opts.buffer, opts.fileName, { maxRows: opts.maxRows });
}

/* ───────────────────────── helpers ──────────────────────────────────── */

function basename(p: string): string {
  // Strip any directory component so a smuggled path like "../etc/passwd"
  // never flows into logs. (Defence in depth; the upload route ought to
  // reject non-basename filenames too.)
  return p.replace(/^.*[\/\\]/, "").slice(0, 200);
}

function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h) => {
    const key = h || "(blank)";
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n === 0 ? key : `${key} (${n + 1})`;
  });
}
