// e& money (formerly Etisalat Cash) SMS templates (spec 06 §4.10). Seeded ONLY
// from the published Tahweel samples EM-1 / EM-2 ([TAHWEEL-S], wallets.md §5.1).
import { COLLECTION_PROVIDERS } from "../providers";
import type { CollectionTemplate } from "../types";
import { AMT, S, re } from "./_shared";

const SENDERS = COLLECTION_PROVIDERS.etisalat_money.smsSenderIds;

/** EM-1. The sample has no space in "باسم<NAME>"; no reference and no time in the text. */
export const ETISALAT_MONEY_SMS_CREDIT_V1: CollectionTemplate = {
  id: "etisalat_money.sms.credit.v1",
  provider: "etisalat_money",
  rail: "wallet",
  channel: "sms",
  direction: "credit",
  locale: "ar",
  version: 1,
  senderIds: SENDERS,
  packages: [],
  regex: re(
    String.raw`^تم استلام مبلغ (?<amount>${AMT}) ج\.م من رقم (?<payer>\d{11}) المسجل باسم ?(?<name>[^\n]+?) بنجاح\.${S}?رصيد محفظتك الحالي (?<balance>${AMT}) ج\.م(?<tail>.*)$`,
  ),
  dateOrder: [],
  hasYear: false,
  hasBalance: true,
  referenceFormat: "none",
  footerDomains: ["spr.ly"],
  autoConfirm: "balance",
  status: "published_sample",
  sampleIds: ["EM-1"],
};

/** EM-2 ("deposit"): no currency word, no balance, no reference; the name ends at the kept newline. */
export const ETISALAT_MONEY_SMS_DEPOSIT_V1: CollectionTemplate = {
  id: "etisalat_money.sms.deposit.v1",
  provider: "etisalat_money",
  rail: "wallet",
  channel: "sms",
  direction: "credit",
  locale: "ar",
  version: 1,
  senderIds: SENDERS,
  packages: [],
  regex: re(
    String.raw`^تم ايداع مبلغ (?<amount>${AMT}) في حسابك بنجاح من رقم حساب (?<payer>\d{10,14}) المسجل باسم ?(?<name>[^\n]+?)(?:\n(?<tail>.*))?$`,
  ),
  dateOrder: [],
  hasYear: false,
  hasBalance: false,
  referenceFormat: "none",
  footerDomains: ["spr.ly"],
  autoConfirm: "never",
  status: "published_sample",
  sampleIds: ["EM-2"],
};

export const ETISALAT_MONEY_TEMPLATES: readonly CollectionTemplate[] = [
  ETISALAT_MONEY_SMS_CREDIT_V1,
  ETISALAT_MONEY_SMS_DEPOSIT_V1,
];
