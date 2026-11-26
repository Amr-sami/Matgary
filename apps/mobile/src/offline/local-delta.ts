/**
 * localDelta — pure half (doc 06 §6.5 "Stock drift between snapshot and
 * server", §2.2 S7).
 *
 * A sale rung offline moves stock the server has not heard about yet. Until
 * the outbox row lands, the catalogue the POS reads (TanStack ["products"],
 * hydrated from the snapshot) still shows the pre-sale quantity, so a second
 * offline sale of the same product could ring units that are no longer on the
 * shelf — and the server would refuse it with INSUFFICIENT_STOCK hours later,
 * after the customer left. The fix is to let the POS see the reduced stock
 * now: `pendingDeltas()` sums the quantities of every sale row that is not
 * `done`, and `applyDeltas()` subtracts them from the cached products. The
 * cart store caps at `product.quantity`, so the POS blocks the oversell the
 * same way it does online.
 *
 * The delta is DERIVED from the outbox, never stored: a row that syncs,
 * fails-and-is-discarded or is edited disappears from the sum by itself, and
 * the server's answer (invalidated after every successful drain) replaces the
 * whole thing. Server wins, always:
 *  - each ring captures the catalogue's `updatedAt` of every product it
 *    touches (SalePayload.catalogUpdatedAt, a client-only sidecar). Its
 *    units are subtracted only while the server still reports THAT exact
 *    stamp; any other value means the server has moved the product since
 *    (a restock, a stock take, or this very sale landing) and our decrement
 *    is either already counted or superseded (§6.5). Two server strings are
 *    compared — the device clock is never held against the server's, which
 *    on a phone whose clock runs behind would silently skip real decrements;
 *  - a ring that captured no stamp (older row; catalogue without the field)
 *    is always ours to subtract;
 *  - quantities never go below 0.
 *
 * No runtime imports — `node --test --experimental-strip-types` runs
 * __tests__/local-delta.test.ts against this file.
 */

/** The slice of an outbox row this module reads. */
export interface DeltaRow {
  kind: string;
  status: string;
  payload: unknown;
}

/** The slice of a catalogue product this module touches. */
export interface DeltaProduct {
  id: string;
  quantity: number;
  updatedAt?: string | null;
}

export interface Delta {
  /** Units rung across all pending rows. */
  qty: number;
  /**
   * The same units grouped by the catalogue `updatedAt` the ring saw for
   * this product (`null` when it captured none). applyDeltas subtracts a
   * group only while the server still reports that stamp.
   */
  byStamp: ReadonlyMap<string | null, number>;
}

export type Deltas = ReadonlyMap<string, Delta>;

export const SALE_KIND = "sale";
/** Rows in these states have NOT been booked by the server; their stock is still "ours". */
const PENDING_STATUSES: ReadonlySet<string> = new Set(["queued", "sending", "failed"]);

interface SaleLine {
  productId: string;
  quantity: number;
}

/** The `catalogUpdatedAt` sidecar of a sale payload, or {} when absent / malformed. */
function stampsOf(payload: unknown): Record<string, string> {
  if (typeof payload !== "object" || payload === null) return {};
  const raw = (payload as { catalogUpdatedAt?: unknown }).catalogUpdatedAt;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string" && v) out[id] = v;
  return out;
}

function linesOf(payload: unknown): SaleLine[] {
  if (typeof payload !== "object" || payload === null) return [];
  const lines = (payload as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) return [];
  return lines.filter(
    (l): l is SaleLine =>
      typeof l === "object" && l !== null && typeof (l as SaleLine).productId === "string" && typeof (l as SaleLine).quantity === "number",
  );
}

/** Sum the rung quantities of every not-yet-booked sale row, per product. */
export function pendingDeltas(rows: ReadonlyArray<DeltaRow>): Deltas {
  const out = new Map<string, Delta>();
  for (const row of rows) {
    if (row.kind !== SALE_KIND || !PENDING_STATUSES.has(row.status)) continue;
    const stamps = stampsOf(row.payload);
    for (const l of linesOf(row.payload)) {
      if (!(l.quantity > 0)) continue;
      const stamp = stamps[l.productId] ?? null;
      let cur = out.get(l.productId) as { qty: number; byStamp: Map<string | null, number> } | undefined;
      if (!cur) {
        cur = { qty: 0, byStamp: new Map() };
        out.set(l.productId, cur);
      }
      cur.qty += l.quantity;
      cur.byStamp.set(stamp, (cur.byStamp.get(stamp) ?? 0) + l.quantity);
    }
  }
  return out;
}

/** Same server moment? String-equal, or the same instant when both parse (formatting may differ between fetches). */
function sameStamp(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = Date.parse(a);
  return Number.isFinite(ta) && ta === Date.parse(b);
}

/**
 * Apply the deltas to a product list. Returns the SAME array when nothing
 * changes (so a cache write can be skipped) and a new array otherwise; only
 * touched products are copied.
 */
export function applyDeltas<P extends DeltaProduct>(products: ReadonlyArray<P>, deltas: Deltas): P[] {
  if (deltas.size === 0) return products as P[];
  let changed = false;
  const out = products.map((p) => {
    const d = deltas.get(p.id);
    if (!d) return p;
    // Server wins: a ring is subtracted only while the server still reports
    // the `updatedAt` it was rung against. No stamp on either side → ours.
    let qty = 0;
    for (const [stamp, n] of d.byStamp) {
      if (stamp === null || !p.updatedAt || sameStamp(stamp, p.updatedAt)) qty += n;
    }
    if (qty === 0) return p;
    const quantity = Math.max(0, p.quantity - qty);
    if (quantity === p.quantity) return p;
    changed = true;
    return { ...p, quantity };
  });
  return changed ? out : (products as P[]);
}
