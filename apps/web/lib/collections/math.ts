// Digital collections — pure helpers, no IO (05 §4.6, §4.9, §4.10, §4.13).
// All money is compared and allocated in integer piasters; the wire and the
// numeric(14,2) columns carry decimal strings / numbers.
//
// Not here, on purpose:
// - the account mask is 06's domain `accountMask()` (one ASCII string for the
//   UI and every receipt renderer, 05 ARCH CR 9);
// - the IBAN / wallet validators are 06's domain `normalizeIban()` /
//   `normalizeWalletMsisdn()` (03 §B.16: "the one IBAN / wallet validator for
//   05, 09 and 12"). 05's temporary `isValidEgIban` was to live here only until
//   06 part A landed; 06-A landed first, so it was never written.

import { fromPiasters, toPiasters } from "@matgary/domain/collections/normalize";
import type {
  CollectionStatus,
  SaleCollectionStatus,
} from "@matgary/domain/collections/types";

export { fromPiasters, toPiasters };

/** Split transfers per sale (Q5; zod caps the wire at the same number). */
export const MAX_COLLECTION_PARTS = 4;

/**
 * A JS number of pounds → integer piasters, half-up in decimal. Unlike the
 * strict domain `toPiasters` (which refuses more than 2 decimals), this is for
 * amounts the server computed in floating point (cart totals, 0.1 + 0.2) or a
 * client sent with more precision: 30.000000000000004 → 3000, 1.005 → 101.
 */
export function roundToPiasters(amount: number | string): number {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) throw new RangeError(`roundToPiasters: not a finite amount: ${amount}`);
  // The tiny bias turns 100.49999999999999 (1.005 * 100) into 100.5 → 101.
  const scaled = n * 100;
  return Math.round(scaled + (scaled >= 0 ? 1e-7 : -1e-7));
}

// ─────────────────────────────────────────────────────────────────────────────
// normaliseParts (05 §4.6)
// ─────────────────────────────────────────────────────────────────────────────

export interface CollectionPartInput {
  accountId: string;
  amount: number;
  payerPhoneLast4?: string | null;
  payerReference?: string | null;
}

export interface NormalisePartsInput {
  /** The invoice total (pounds). */
  total: number | string;
  /** Single-transfer case: the account the cashier picked (may be absent). */
  collectionAccountId?: string | null;
  /** Split case: 1..4 parts in the cashier's order. */
  collectionParts?: CollectionPartInput[] | null;
  /** Single-transfer case payer hints. */
  payerPhoneLast4?: string | null;
  payerReference?: string | null;
}

export interface NormalisedPart {
  /** 1..n after dropping zero parts. */
  partNo: number;
  /** null = none given (the repo then resolves the branch POS default). */
  accountId: string | null;
  amountPt: number;
  payerPhoneLast4: string | null;
  /** lower-cased. */
  payerReference: string | null;
}

export interface NormalisedParts {
  parts: NormalisedPart[];
  /** Σ parts exceeded the total and was trimmed from the last part backwards
   *  (flag `parts_clamped` on every part). */
  clamped: boolean;
  totalPt: number;
  /** total − Σ parts: cash taken at the counter (no column; derived). */
  cashRemainderPt: number;
}

function cleanRef(ref: string | null | undefined): string | null {
  if (ref == null) return null;
  const r = String(ref).trim().toLowerCase();
  return r === "" ? null : r;
}

function cleanLast4(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * The transfer parts a digital sale books (05 §4.6):
 * 1. total ≤ 0 → no parts (the `amount > 0` CHECK; a fully discounted cart
 *    gets no collection);
 * 2. `collectionParts` non-empty → keep order, round each to piasters, drop
 *    parts ≤ 0; if Σ > total, reduce from the LAST part backwards until
 *    Σ = total, dropping parts that reach 0 (`clamped`). Σ < total is legal:
 *    the remainder is cash;
 * 3. otherwise one part = the total, on `collectionAccountId` (or null), with
 *    the top-level payer hints;
 * 4. partNo = 1..n after dropping.
 */
export function normaliseParts(input: NormalisePartsInput): NormalisedParts {
  const totalPt = roundToPiasters(input.total);
  if (totalPt <= 0) {
    return { parts: [], clamped: false, totalPt, cashRemainderPt: 0 };
  }

  const given = input.collectionParts ?? [];
  if (given.length === 0) {
    return {
      parts: [
        {
          partNo: 1,
          accountId: input.collectionAccountId ?? null,
          amountPt: totalPt,
          payerPhoneLast4: cleanLast4(input.payerPhoneLast4),
          payerReference: cleanRef(input.payerReference),
        },
      ],
      clamped: false,
      totalPt,
      cashRemainderPt: 0,
    };
  }

  const kept = given
    .map((p) => ({
      accountId: p.accountId ?? null,
      amountPt: roundToPiasters(p.amount),
      payerPhoneLast4: cleanLast4(p.payerPhoneLast4),
      payerReference: cleanRef(p.payerReference),
    }))
    .filter((p) => p.amountPt > 0);

  let sum = kept.reduce((s, p) => s + p.amountPt, 0);
  let clamped = false;
  for (let i = kept.length - 1; i >= 0 && sum > totalPt; i--) {
    const excess = sum - totalPt;
    const cut = Math.min(excess, kept[i]!.amountPt);
    kept[i]!.amountPt -= cut;
    sum -= cut;
    clamped = true;
  }
  const parts = kept
    .filter((p) => p.amountPt > 0)
    .map((p, i) => ({ partNo: i + 1, ...p }));
  return { parts, clamped, totalPt, cashRemainderPt: totalPt - sum };
}

// ─────────────────────────────────────────────────────────────────────────────
// allocateRejection (05 §4.10)
// ─────────────────────────────────────────────────────────────────────────────

export interface RejectionLine {
  saleId: string;
  /** Invoice order key 1 (ISO string or Date). */
  saleDate: string | Date;
  totalPricePt: number;
  amountPaidPt: number;
  isReturned: boolean;
}

export interface LineAllocation {
  saleId: string;
  /** Piasters taken off this line's amount_paid. */
  takePt: number;
  newAmountPaidPt: number;
  totalPricePt: number;
}

export interface RejectionAllocation {
  /** Touched lines only, in the order they were taken from. */
  allocations: LineAllocation[];
  /** Part money the lines could not absorb (a later edit lowered totals);
   *  recorded as `details.unallocated`. */
  unallocatedPt: number;
}

function saleDateMs(d: string | Date): number {
  return (d instanceof Date ? d : new Date(d)).getTime();
}

/**
 * Take a rejected part's amount back off the invoice lines: walk the lines in
 * invoice order (sale_date, id) from the LAST backwards — non-returned lines
 * first, returned lines only if still needed — taking min(remaining,
 * amount_paid) per line, in piasters. Σ takes + unallocated = amountPt.
 */
export function allocateRejection(lines: readonly RejectionLine[], amountPt: number): RejectionAllocation {
  const ordered = [...lines].sort((a, b) => {
    const d = saleDateMs(a.saleDate) - saleDateMs(b.saleDate);
    if (d !== 0) return d;
    return a.saleId < b.saleId ? -1 : a.saleId > b.saleId ? 1 : 0;
  });
  const backwards = ordered.reverse();
  const visit = [...backwards.filter((l) => !l.isReturned), ...backwards.filter((l) => l.isReturned)];

  let remaining = Math.max(0, Math.round(amountPt));
  const allocations: LineAllocation[] = [];
  for (const line of visit) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Math.max(0, line.amountPaidPt));
    if (take <= 0) continue;
    allocations.push({
      saleId: line.saleId,
      takePt: take,
      newAmountPaidPt: line.amountPaidPt - take,
      totalPricePt: line.totalPricePt,
    });
    remaining -= take;
  }
  return { allocations, unallocatedPt: remaining };
}

// ─────────────────────────────────────────────────────────────────────────────
// deriveInvoiceStatus / isStale (05 §4.9, §4.13)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The invoice-level `sales.collection_status` from its sale parts: drop
 * `void`; none left → null; any `pending` → pending; else any `rejected` →
 * rejected; else confirmed (`auto_confirmed` counts as confirmed).
 */
export function deriveInvoiceStatus(
  statuses: readonly CollectionStatus[],
): SaleCollectionStatus | null {
  const live = statuses.filter((s) => s !== "void");
  if (live.length === 0) return null;
  if (live.includes("pending")) return "pending";
  if (live.includes("rejected")) return "rejected";
  return "confirmed";
}

/** A pending collection older than the branch's stale threshold
 *  (`now − rung_at > collections_stale_after_minutes`, strictly). */
export function isStale(
  c: { status: CollectionStatus | string; rungAt: string | Date },
  staleAfterMinutes: number,
  now: Date = new Date(),
): boolean {
  if (c.status !== "pending") return false;
  const age = now.getTime() - saleDateMs(c.rungAt);
  return age > staleAfterMinutes * 60_000;
}
