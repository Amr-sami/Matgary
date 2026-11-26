// Orange Cash SMS templates (spec 06 §4.10). Seeded ONLY from the published
// Tahweel samples OC-1 / OC-2 / OC-3 ([TAHWEEL-S], wallets.md §5.1).
import { COLLECTION_PROVIDERS } from "../providers";
import type { CollectionTemplate } from "../types";
import { AMT, S, re } from "./_shared";

const SENDERS = COLLECTION_PROVIDERS.orange_cash.smsSenderIds;

/** OC-1: name only (no payer phone), balance, 10-digit reference, marketing tail. */
export const ORANGE_CASH_SMS_CREDIT_V2: CollectionTemplate = {
  id: "orange_cash.sms.credit.v2",
  provider: "orange_cash",
  rail: "wallet",
  channel: "sms",
  direction: "credit",
  locale: "ar",
  version: 2,
  senderIds: SENDERS,
  packages: [],
  regex: re(
    String.raw`^تم استلام عمليه تحويل اموال بمبلغ (?<amount>${AMT}) جنيه من (?<name>[^،\n]+?) ?، ?رصيدك الحالي (?<balance>${AMT}) جنيه\.${S}?رقم المعامله (?<ref>\d{10})(?<tail>.*)$`,
  ),
  dateOrder: [],
  hasYear: false,
  hasBalance: true,
  referenceFormat: "digits10",
  footerDomains: ["myo.orange.eg"],
  autoConfirm: "balance",
  status: "published_sample",
  sampleIds: ["OC-1"],
};

/** OC-2 (older wording): Arabic-Indic digits in the sample, no balance. */
export const ORANGE_CASH_SMS_CREDIT_V1: CollectionTemplate = {
  id: "orange_cash.sms.credit.v1",
  provider: "orange_cash",
  rail: "wallet",
  channel: "sms",
  direction: "credit",
  locale: "ar",
  version: 1,
  senderIds: SENDERS,
  packages: [],
  regex: re(
    String.raw`^تم استلام عمليه تحويل اموال بمبلغ (?<amount>${AMT}) جنيه من (?<name>[^،\n]+?) ?، ?رقم المعامله (?<ref>\d{10})(?<tail>.*)$`,
  ),
  dateOrder: [],
  hasYear: false,
  hasBalance: false,
  referenceFormat: "digits10",
  footerDomains: ["myo.orange.eg"],
  autoConfirm: "never",
  status: "published_sample",
  sampleIds: ["OC-2"],
};

/** OC-3: an agent cash-in (not a customer payment). It extends the balance chain (06 §4.13 balanceCheck). */
export const ORANGE_CASH_SMS_CASH_IN_V1: CollectionTemplate = {
  id: "orange_cash.sms.cash_in.v1",
  provider: "orange_cash",
  rail: "wallet",
  channel: "sms",
  direction: "cash_in",
  locale: "en",
  version: 1,
  senderIds: SENDERS,
  packages: [],
  regex: re(
    String.raw`^Successful cash-in with amount EGP (?<amount>${AMT})\.?${S}Your current balance is EGP (?<balance>${AMT})(?<tail>.*)$`,
  ),
  dateOrder: [],
  hasYear: false,
  hasBalance: true,
  referenceFormat: "none",
  footerDomains: ["myo.orange.eg"],
  autoConfirm: "never",
  status: "published_sample",
  sampleIds: ["OC-3"],
};

export const ORANGE_CASH_TEMPLATES: readonly CollectionTemplate[] = [
  ORANGE_CASH_SMS_CREDIT_V2,
  ORANGE_CASH_SMS_CREDIT_V1,
  ORANGE_CASH_SMS_CASH_IN_V1,
];
