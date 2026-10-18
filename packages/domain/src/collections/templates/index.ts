// Digital collections — the template registry (spec 06 §4.10, §4.15).
//
// Every template is seeded ONLY from a published sample (never an invented
// format) and ships as `status: "published_sample"`, so autoConfirmGate can
// never pass on real data before a reviewed promotion (§4.15). Notification
// templates: none, because no notification text has been published
// (wallets.md §5.4, android.md §5); they arrive from Q9 pilot samples through
// the promotion procedure.
//
// Order = the 06 §4.10 table order; parse.ts tries sender-matched templates
// first, then the rest in this order.
//
// Server-authoritative: mobile never imports templates/* (06 §4.1).

import type { CollectionTemplate } from "../types";
import { ADIB_TEMPLATES } from "./adib";
import { BDC_TEMPLATES } from "./bdc";
import { CIB_TEMPLATES } from "./cib";
import { ETISALAT_MONEY_TEMPLATES } from "./etisalat_money";
import { GENERIC_IPN_TEMPLATES } from "./generic_ipn";
import { NBE_TEMPLATES } from "./nbe";
import { ORANGE_CASH_TEMPLATES } from "./orange_cash";
import { QNB_TEMPLATES } from "./qnb";
import { VODAFONE_CASH_TEMPLATES } from "./vodafone_cash";

export const COLLECTION_TEMPLATES: readonly CollectionTemplate[] = [
  ...VODAFONE_CASH_TEMPLATES,
  ...ETISALAT_MONEY_TEMPLATES,
  ...ORANGE_CASH_TEMPLATES,
  ...NBE_TEMPLATES,
  ...CIB_TEMPLATES,
  ...QNB_TEMPLATES,
  ...BDC_TEMPLATES,
  ...GENERIC_IPN_TEMPLATES,
  ...ADIB_TEMPLATES,
];

const BY_ID: Readonly<Record<string, CollectionTemplate>> = (() => {
  const out: Record<string, CollectionTemplate> = {};
  for (const t of COLLECTION_TEMPLATES) out[t.id] = t;
  return out;
})();

/** The template with this id, or null. */
export function templateById(id: string): CollectionTemplate | null {
  return Object.prototype.hasOwnProperty.call(BY_ID, id) ? BY_ID[id] : null;
}

/**
 * `published_sample` → `pilot_verified` (§4.15, 03 §D.5): ≥ 3 `kind: "pilot"`
 * fixtures from ≥ 2 distinct phones, senderIds / packages observed on a real
 * device, a second reviewer. Enforced by __tests__/templates.test.ts.
 */
export const PROMOTION_RULE = { minPilotSamples: 3, minDistinctPhones: 2 } as const;
