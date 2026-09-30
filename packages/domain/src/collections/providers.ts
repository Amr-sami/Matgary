// Digital collections — the provider registry (spec 06 §4.4, 03 §B.16).
//
// One entry per `CollectionProvider` (03 §B.1). The table is the source of
// truth for three things spec 07 serves to phones through
// GET /api/v1/collections/ingest/config, and spec 09 uses on the account form:
// - `androidPackages`: bank / wallet APP package ids, each confirmed on Google
//   Play 2026-09-27 (_research/android.md §1.4). Never an SMS-app package (Q7;
//   the providers test enforces it).
// - `smsSenderIds`: alphanumeric sender ids seen in PUBLISHED samples only
//   ([] = unknown). Numeric short codes never gain trust, so none is listed
//   (the "1234" code in a Tahweel synthetic test is not an observed sender).
// - `balanceCap`: the maximum wallet balance in EGP (wallets only; null =
//   unknown or not a wallet).
// Wallet-app notification texts are unpublished (W4, A4): a package listed
// here lets spec 11 listen and collect, but no notification TEMPLATE exists
// until Q9 pilot samples.
//
// Hermes-safe; types-only import.

import type { CollectionProvider, CollectionRail } from "./types";
import { COLLECTION_PROVIDER_VALUES } from "./types";

export interface CollectionProviderInfo {
  id: CollectionProvider;
  rail: CollectionRail;
  /** i18n key of the display name; the subtree is owned by spec 05. */
  labelKey: `app.collections.vocab.providers.${CollectionProvider}`;
  /** android.md §1.4, each confirmed on Play 2026-09-27. */
  androidPackages: readonly string[];
  /** Alphanumeric ids seen in published samples; [] = unknown. */
  smsSenderIds: readonly string[];
  /** EGP; wallets only. */
  balanceCap: number | null;
  /** Research tags (the full URLs live in _research/*.md). */
  sources: readonly string[];
}

/** The InstaPay app itself: a rail-level app, not a bank. */
export const INSTAPAY_APP_PACKAGE = "com.egyptianbanks.instapay";

function entry(
  id: CollectionProvider,
  rail: CollectionRail,
  androidPackages: readonly string[],
  smsSenderIds: readonly string[],
  balanceCap: number | null,
  sources: readonly string[],
): CollectionProviderInfo {
  return {
    id,
    rail,
    labelKey: `app.collections.vocab.providers.${id}`,
    androidPackages,
    smsSenderIds,
    balanceCap,
    sources,
  };
}

export const COLLECTION_PROVIDERS: Readonly<Record<CollectionProvider, CollectionProviderInfo>> = {
  // --- rail instapay: banks whose accounts receive InstaPay transfers --------
  nbe: entry("nbe", "instapay", ["com.ofss.obdx.and.nbe.com.eg"], ["AHLY", "BanK-AlAhly", "Bank-Alahly"], null, [
    "DABBARHA",
    "PENNY",
    "ZEN",
  ]),
  cib: entry("cib", "instapay", ["com.cibeg.ddc1.digitalbanking.live"], ["cib"], null, ["ZEN"]),
  qnb: entry("qnb", "instapay", ["eg.com.qnb.eazymobile"], ["QNB EGYPT"], null, ["ESLAM", "MONYVI"]),
  // Sender id unobserved (I6).
  banque_misr: entry("banque_misr", "instapay", ["com.BanqueMisr.MobileBanking"], [], null, ["android.md §1.4"]),
  // Sender id unknown (I6): no allowlist, so bdc never auto-confirms.
  bdc: entry("bdc", "instapay", [], [], null, ["MATTIYA", "BDC"]),
  aaib: entry("aaib", "instapay", [], [], null, []),
  alexbank: entry("alexbank", "instapay", [], [], null, []),
  hsbc: entry("hsbc", "instapay", [], [], null, []),
  faisal: entry("faisal", "instapay", [], [], null, []),
  adib: entry("adib", "instapay", [], [], null, []),
  other_bank: entry("other_bank", "instapay", [], [], null, []),

  // --- rail wallet: mobile wallets --------------------------------------------
  // Vodafone Cash lives inside the Ana Vodafone app.
  vodafone_cash: entry("vodafone_cash", "wallet", ["com.emeint.android.myservices"], ["vf-cash"], 100_000, [
    "TAHWEEL-S",
    "VF-MT",
  ]),
  etisalat_money: entry("etisalat_money", "wallet", ["com.etisalat.flous"], ["e& money"], 200_000, [
    "TAHWEEL-S",
    "MASRAWY-LIM",
  ]),
  // Orange Cash lives inside the Orange Max it app.
  orange_cash: entry(
    "orange_cash",
    "wallet",
    ["com.orange.mobinilandme"],
    ["Orange Cash", "OrangeCash", "اورنج كاش"],
    200_000,
    ["TAHWEEL-S", "OR"],
  ),
  // Sender id unobserved (W3/W6).
  we_pay: entry("we_pay", "wallet", ["com.TE.WEWallet"], [], 200_000, ["WE", "WE-PLAY"]),
  nbe_phone_cash: entry("nbe_phone_cash", "wallet", ["com.emeint.android.mwallet"], [], 100_000, [
    "BNOK24",
    "NBE-PLAY",
  ]),
  // Balance cap UNVERIFIED.
  bm_wallet: entry("bm_wallet", "wallet", ["com.emeint.android.mwallet.bm"], [], null, ["android.md §1.4"]),
  other_wallet: entry("other_wallet", "wallet", [], [], null, []),
};

/** The registry entry, or null for an unknown id. */
export function providerById(id: string): CollectionProviderInfo | null {
  return (COLLECTION_PROVIDER_VALUES as readonly string[]).indexOf(id) === -1
    ? null
    : COLLECTION_PROVIDERS[id as CollectionProvider];
}

function sortedUnique(values: readonly string[]): string[] {
  const seen: Record<string, true> = {};
  const out: string[] = [];
  for (const v of values) {
    if (!seen[v]) {
      seen[v] = true;
      out.push(v);
    }
  }
  return out.sort();
}

/**
 * The Android packages to listen to for these providers, plus the InstaPay
 * app when any of them is on the instapay rail. Sorted, unique.
 */
export function packagesForProviders(ids: readonly CollectionProvider[]): string[] {
  const all: string[] = [];
  let anyInstapay = false;
  for (const id of ids) {
    const p = COLLECTION_PROVIDERS[id];
    if (!p) continue;
    if (p.rail === "instapay") anyInstapay = true;
    for (const pkg of p.androidPackages) all.push(pkg);
  }
  if (anyInstapay) all.push(INSTAPAY_APP_PACKAGE);
  return sortedUnique(all);
}

/** The SMS sender ids of these providers. Sorted, unique. */
export function sendersForProviders(ids: readonly CollectionProvider[]): string[] {
  const all: string[] = [];
  for (const id of ids) {
    const p = COLLECTION_PROVIDERS[id];
    if (!p) continue;
    for (const s of p.smsSenderIds) all.push(s);
  }
  return sortedUnique(all);
}
