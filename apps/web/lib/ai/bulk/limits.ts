/**
 * F10.3 — Safety limits for bulk operations.
 *
 * Centralised so the agent prompt, preview, executor, and tool schema all
 * read from one source. Tightening a limit requires exactly one edit here.
 */

export const BULK_LIMITS = {
  /** Hard cap on how many records a single bulk preview can target.
   *  Larger sets require the admin UI (future) or staged imports. */
  maxRecords: 500,
  /** Max percentage change for price/quantity increase_pct/decrease_pct. */
  maxPercentChange: 50,
  /** Max absolute-value change for price in a single bulk op (EGP). */
  maxPriceDelta: 10_000,
  /** Max absolute-value change for quantity in a single bulk op. */
  maxQuantityDelta: 10_000,
  /** How long a bulk-preview pending action lives before it expires. */
  pendingTtlSec: 5 * 60,
} as const;

/** Validate a numeric change against the per-op cap. Returns null when safe. */
export function validateDelta(opts: {
  kind: "price" | "quantity";
  mode: "set" | "increase_pct" | "decrease_pct" | "increase_by" | "decrease_by";
  value: number;
}): string | null {
  if (!Number.isFinite(opts.value) || opts.value < 0) {
    return `value must be a non-negative number`;
  }
  if (opts.mode.endsWith("_pct") && opts.value > BULK_LIMITS.maxPercentChange) {
    return `percentage exceeds ${BULK_LIMITS.maxPercentChange}% cap`;
  }
  const cap = opts.kind === "price" ? BULK_LIMITS.maxPriceDelta : BULK_LIMITS.maxQuantityDelta;
  if (opts.mode.endsWith("_by") && opts.value > cap) {
    return `absolute delta exceeds ${cap} cap`;
  }
  return null;
}
