// Digital collections — credit ↔ collection matching hooks.
//
// M1 no-op; spec 07 owns this file from M2 (07 ARCH CHANGE REQUEST 1,
// accepted): 07 replaces the BODIES only, the signatures below are binding
// (03 §B.4, 05 ARCH CHANGE REQUEST 7), so 07 never edits operations.ts or
// lib/repo/collections.ts.
//
// Call sites (spec 05):
//   - reverseMatch    — inside the cart / legacy-sale transaction, right after
//                       the collection rows are written (03 §C.8 step 9: a
//                       credit that arrived before the sale was rung up);
//   - flushMatchEffects — after that transaction commits, with the value
//                       reverseMatch returned (activity, fanout, cache bust
//                       for reverse-matched credits). Never throws, so it
//                       cannot turn a committed sale into a 500;
//   - releaseCredits  — inside reopen and inside the "last line deleted →
//                       void" hook (03 §F): a credit matched to the
//                       collection goes back to `unmatched`.

import type { TenantTx } from "@/lib/collections/flags";

// The M1 bodies ignore their arguments on purpose: the signatures are 07's
// contract (03 §B.4), filled at M2.
/* eslint-disable @typescript-eslint/no-unused-vars */

/** Placeholder; 07 redefines it (05 never reads inside MatchEffects). */
export type CreditNotify = { creditId: string };

export type MatchEffects = {
  autoConfirmed: { collectionId: string; creditId: string; branchId: string }[];
  notify: CreditNotify[];
  bust: boolean;
};

/** Never mutated: callers that need to add effects build a new object. */
export const EMPTY_EFFECTS: MatchEffects = Object.freeze({
  autoConfirmed: [],
  notify: [],
  bust: false,
}) as MatchEffects;

/** M1: no credits exist yet (0056 is M2), so nothing can reverse-match. */
export async function reverseMatch(
  _tx: TenantTx,
  _tenantId: string,
  _collectionIds: string[],
): Promise<MatchEffects> {
  return EMPTY_EFFECTS;
}

/** M1: nothing to flush. 07's body must keep the never-throws contract. */
export function flushMatchEffects(_tenantId: string, _effects: MatchEffects): void {}

/** M1: no credit is ever matched, so there is nothing to release. */
export async function releaseCredits(
  _tx: TenantTx,
  _tenantId: string,
  _collectionIds: string[],
  _reason: "reopened" | "sale_deleted",
): Promise<void> {}
