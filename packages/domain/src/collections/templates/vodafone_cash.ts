// Vodafone Cash SMS templates (spec 06 §4.10). Seeded ONLY from the published
// Tahweel samples VF-1 / VF-2 ([TAHWEEL-S], _research/wallets.md §5.1). The
// regex sources are the normalised wording (أ/إ/آ → ا, ى → ي, ة → ه, tatweel
// removed) and are written exactly as 06 §4.10 has them.
import { COLLECTION_PROVIDERS } from "../providers";
import type { CollectionTemplate } from "../types";
import { AMT, S, re } from "./_shared";

const SENDERS = COLLECTION_PROVIDERS.vodafone_cash.smsSenderIds;

/** VF-1. "17:36 26-07-27" reads as YY-MM-DD; DD-MM-YY lands in the future and is rejected by the date window. */
export const VODAFONE_CASH_SMS_CREDIT_V1: CollectionTemplate = {
  id: "vodafone_cash.sms.credit.v1",
  provider: "vodafone_cash",
  rail: "wallet",
  channel: "sms",
  direction: "credit",
  locale: "ar",
  version: 1,
  senderIds: SENDERS,
  packages: [],
  regex: re(
    String.raw`^تم استلام مبلغ (?<amount>${AMT}) جنيه من رقم (?<payer>\d{11}) المسجل باسم ?(?<name>[^\n]+?) علي رقم محفظتك (?<receiving>\d{11})\.${S}?رصيدك الحالي: ?(?<balance>${AMT}) جنيه${S}تاريخ العمليه: ?(?<time>\d{1,2}:\d{2}) (?<d1>\d{2})-(?<d2>\d{2})-(?<d3>\d{2})${S}رقم العمليه: ?(?<ref>\d{12})(?<tail>.*)$`,
  ),
  dateOrder: ["YMD", "DMY"],
  hasYear: true,
  hasBalance: true,
  referenceFormat: "digits12",
  footerDomains: ["vf.eg"],
  autoConfirm: "balance",
  status: "published_sample",
  sampleIds: ["VF-1"],
};

/** VF-2: an outgoing transfer. Only amount + balance are kept (D06-a); the counterparty is never exported. */
export const VODAFONE_CASH_SMS_DEBIT_V1: CollectionTemplate = {
  id: "vodafone_cash.sms.debit.v1",
  provider: "vodafone_cash",
  rail: "wallet",
  channel: "sms",
  direction: "debit",
  locale: "ar",
  version: 1,
  senderIds: SENDERS,
  packages: [],
  regex: re(
    String.raw`^تم تحويل مبلغ (?<amount>${AMT}) جنيه الي رقم (?<counterparty>\d{11}) بنجاح\.${S}?رصيدك الحالي: ?(?<balance>${AMT}) جنيه(?<tail>.*)$`,
  ),
  dateOrder: [],
  hasYear: false,
  hasBalance: true,
  referenceFormat: "none",
  footerDomains: [],
  autoConfirm: "never",
  status: "published_sample",
  sampleIds: ["VF-2"],
};

export const VODAFONE_CASH_TEMPLATES: readonly CollectionTemplate[] = [
  VODAFONE_CASH_SMS_CREDIT_V1,
  VODAFONE_CASH_SMS_DEBIT_V1,
];
