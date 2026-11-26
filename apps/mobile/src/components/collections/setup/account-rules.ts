/**
 * The real spec 06 validators and provider registry, bound for the account
 * form (doc 15 spec 09 §4.5): `account-form.ts` stays import-free (so plain
 * Node tests it) and receives these.
 */
import { COLLECTION_PROVIDERS, type CollectionProviderInfo } from "@matgary/domain/collections/providers";
import { ipaHandleFromLink, ipaLinkFromShareText, isValidIpaLink } from "@matgary/domain/collections/ipa";
import { normalizeIban, normalizeWalletMsisdn } from "@matgary/domain/collections/normalize";

import type { AccountRules, ProviderRails, Rail } from "./account-form";

export const ACCOUNT_RULES: AccountRules = {
  isValidIpaLink,
  ipaHandleFromLink,
  ipaLinkFromShareText,
  normalizeIban: (raw) => normalizeIban(raw),
  normalizeWalletMsisdn: (raw) => normalizeWalletMsisdn(raw),
};

export const PROVIDER_RAILS: ProviderRails = COLLECTION_PROVIDERS;

/** The providers of one rail, in the registry's order (banks, then "other"). */
export function providersForRail(rail: Rail): CollectionProviderInfo[] {
  return (Object.values(COLLECTION_PROVIDERS) as CollectionProviderInfo[]).filter((p) => p.rail === rail);
}
