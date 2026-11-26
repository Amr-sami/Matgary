import { listProducts } from "@/lib/repo/catalog";
import type { Product } from "@/lib/types";

import { BULK_LIMITS, validateDelta } from "./limits";

/**
 * F10.3 — Deterministic bulk candidate resolution + preview building.
 *
 * The AI proposes a filter + an operation; the server resolves the exact set
 * of affected products using existing repo helpers, computes the before/after
 * values, and returns a structured preview the user confirms.
 *
 * Filters supported (F10.3 scope — products only):
 *   • brand: exact (case-insensitive) match against product.brand
 *   • categoryId: uuid match
 *   • productIds: explicit list (bounded by BULK_LIMITS.maxRecords)
 *   • lowStock: products at/below their lowStockThreshold
 *
 * SAFETY — the LLM only provides the filter + operation values. All numeric
 * math + the actual candidate set + the final after-value happen here,
 * entirely server-side. The LLM has no path to inject a price.
 */

export type PriceMode =
  | "set"
  | "increase_pct"
  | "decrease_pct"
  | "increase_by"
  | "decrease_by";

export interface ProductFilter {
  brand?: string;
  productIds?: string[];
  /** When true, include only products at/below their lowStockThreshold. */
  lowStock?: boolean;
}

export interface BulkPriceChange {
  productId: string;
  name: string;
  brand: string | null;
  sku: string | null;
  beforePrice: number;
  afterPrice: number;
  delta: number;
}

export interface BulkPricePreview {
  mode: PriceMode;
  value: number;
  totalMatched: number;
  totalEligible: number;
  skippedOverCap: number;
  changes: BulkPriceChange[];
  /** Sum of (after - before) across the eligible set. Signed. */
  totalPriceDelta: number;
}

export class BulkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BulkError";
    this.code = code;
  }
}

/* ───────────────────────── resolve ─────────────────────────────────── */

export async function resolveCandidates(opts: {
  tenantId: string;
  branchId: string | null;
  filter: ProductFilter;
}): Promise<Product[]> {
  const all = await listProducts(opts.tenantId, opts.branchId);
  let candidates = all;

  if (opts.filter.brand) {
    const needle = opts.filter.brand.trim().toLowerCase();
    candidates = candidates.filter(
      (p) => (p.brand ?? "").toLowerCase() === needle,
    );
  }
  if (opts.filter.productIds && opts.filter.productIds.length > 0) {
    const set = new Set(opts.filter.productIds);
    candidates = candidates.filter((p) => set.has(p.id));
  }
  if (opts.filter.lowStock) {
    candidates = candidates.filter((p) => p.quantity <= p.lowStockThreshold);
  }
  return candidates;
}

/* ───────────────────────── compute preview ─────────────────────────── */

export function computeBulkPricePreview(opts: {
  candidates: Product[];
  mode: PriceMode;
  value: number;
}): BulkPricePreview {
  const err = validateDelta({ kind: "price", mode: opts.mode, value: opts.value });
  if (err) throw new BulkError("INVALID_VALUE", err);

  const totalMatched = opts.candidates.length;
  // F10.3 hard cap. Agent prompt tells the LLM to narrow the filter when it
  // sees skippedOverCap > 0.
  const eligible = opts.candidates.slice(0, BULK_LIMITS.maxRecords);
  const skippedOverCap = Math.max(0, totalMatched - eligible.length);

  const changes: BulkPriceChange[] = [];
  let totalDelta = 0;
  for (const p of eligible) {
    const before = Number(p.price);
    const after = applyMode(before, opts.mode, opts.value);
    if (after < 0) {
      // Flag this row as "would go negative" via delta but DON'T include it
      // in totals; it won't be executed.
      continue;
    }
    changes.push({
      productId: p.id,
      name: p.name,
      brand: p.brand ?? null,
      sku: p.sku ?? null,
      beforePrice: round2(before),
      afterPrice: round2(after),
      delta: round2(after - before),
    });
    totalDelta += after - before;
  }

  return {
    mode: opts.mode,
    value: opts.value,
    totalMatched,
    totalEligible: changes.length,
    skippedOverCap,
    changes,
    totalPriceDelta: round2(totalDelta),
  };
}

function applyMode(current: number, mode: PriceMode, value: number): number {
  switch (mode) {
    case "set":
      return value;
    case "increase_by":
      return current + value;
    case "decrease_by":
      return current - value;
    case "increase_pct":
      return current * (1 + value / 100);
    case "decrease_pct":
      return current * (1 - value / 100);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ───────────────── F10.3 (extended) — quantity + threshold ───────── */

/** Integer-valued modes for quantity/threshold bulk ops. `*_pct` reused
 *  only for context — percentage changes on integer counts are rounded. */
export type QuantityMode = PriceMode;

export interface BulkIntChange {
  productId: string;
  name: string;
  brand: string | null;
  sku: string | null;
  before: number;
  after: number;
  delta: number;
}

export interface BulkIntPreview {
  field: "quantity" | "lowStockThreshold";
  mode: QuantityMode;
  value: number;
  totalMatched: number;
  totalEligible: number;
  skippedOverCap: number;
  changes: BulkIntChange[];
  totalDelta: number;
}

/** Shared compute for quantity + threshold. `pickCurrent` extracts the
 *  current value from a Product so we can reuse the same math for either
 *  field. Negative results are skipped (quantities can't go negative). */
export function computeBulkIntPreview(opts: {
  candidates: Product[];
  mode: QuantityMode;
  value: number;
  field: "quantity" | "lowStockThreshold";
}): BulkIntPreview {
  const err = validateDelta({ kind: "quantity", mode: opts.mode, value: opts.value });
  if (err) throw new BulkError("INVALID_VALUE", err);

  const totalMatched = opts.candidates.length;
  const eligible = opts.candidates.slice(0, BULK_LIMITS.maxRecords);
  const skippedOverCap = Math.max(0, totalMatched - eligible.length);

  const pickCurrent = (p: Product): number =>
    opts.field === "quantity" ? p.quantity : p.lowStockThreshold;

  const changes: BulkIntChange[] = [];
  let totalDelta = 0;
  for (const p of eligible) {
    const before = pickCurrent(p);
    const raw = applyMode(before, opts.mode, opts.value);
    const after = Math.floor(raw); // integer field
    if (after < 0) continue; // skip negative — never shrink below 0
    changes.push({
      productId: p.id,
      name: p.name,
      brand: p.brand ?? null,
      sku: p.sku ?? null,
      before,
      after,
      delta: after - before,
    });
    totalDelta += after - before;
  }

  return {
    field: opts.field,
    mode: opts.mode,
    value: opts.value,
    totalMatched,
    totalEligible: changes.length,
    skippedOverCap,
    changes,
    totalDelta,
  };
}
