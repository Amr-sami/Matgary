import { getAdapter } from "./adapters/products";
import type {
  AdapterContext,
  ImportEntityAdapter,
  ProcessedRow,
} from "./adapters/types";

/**
 * F11 — Re-run adapter.validateAndResolve over an array of ProcessedRow so
 * that after a correction / inline edit, the row's status + action + errors
 * reflect the current DB reality instead of the pre-edit snapshot.
 *
 * Returns a new array; inputs are not mutated. The seenSkus set is rebuilt
 * from scratch each call so intra-file duplicate detection stays accurate
 * after edits (e.g. the user renamed a SKU to match another row).
 *
 * The adapter.validateAndResolve contract is the single source of truth for
 * per-row verdicts; nothing else touches ProcessedRow.status or action.
 */
export async function revalidateRows(opts: {
  entityType: string;
  rows: ProcessedRow[];
  ctx: AdapterContext;
  /** Optional subset — only revalidate rows whose rowIndex is in this set,
   *  leave others as-is. If omitted, every row is revalidated. */
  rowIndexes?: Set<number>;
}): Promise<ProcessedRow[]> {
  const adapter: ImportEntityAdapter = getAdapter(opts.entityType);
  const seenSkus = new Set<string>();
  const out: ProcessedRow[] = new Array(opts.rows.length);

  // First pass — seed seenSkus from rows we are NOT revalidating so duplicate
  // detection accounts for them.
  if (opts.rowIndexes) {
    for (const r of opts.rows) {
      if (opts.rowIndexes.has(r.rowIndex)) continue;
      const sku = typeof r.normalised.sku === "string" ? r.normalised.sku : null;
      if (sku) seenSkus.add(sku.toLowerCase());
    }
  }

  for (let i = 0; i < opts.rows.length; i++) {
    const row = opts.rows[i]!;
    if (opts.rowIndexes && !opts.rowIndexes.has(row.rowIndex)) {
      out[i] = row;
      continue;
    }
    const fresh = await adapter.validateAndResolve({
      rowIndex: row.rowIndex,
      raw: row.raw,
      normalised: row.normalised,
      ctx: opts.ctx,
      seenSkus,
    });
    out[i] = fresh;
  }
  return out;
}
