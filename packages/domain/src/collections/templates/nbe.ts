// National Bank of Egypt SMS templates (spec 06 §4.10). Seeded ONLY from the
// published samples IP-NBE-1…4 ([DABBARHA] [SPENDWISE] [MATTIYA],
// _research/instapay.md §4.3). Dates are MM-DD with no year (24 h clock).
import { COLLECTION_PROVIDERS } from "../providers";
import type { CollectionTemplate } from "../types";
import { AMT, re } from "./_shared";

const SENDERS = COLLECTION_PROVIDERS.nbe.smsSenderIds;

/** IP-NBE-1: InstaPay credit to an account (last 4 of the account). */
export const NBE_SMS_CREDIT_V1: CollectionTemplate = {
  id: "nbe.sms.credit.v1",
  provider: "nbe",
  rail: "instapay",
  channel: "sms",
  direction: "credit",
  locale: "ar",
  version: 1,
  senderIds: SENDERS,
  packages: [],
  regex: re(
    String.raw`^تم اضافه تحويل لحظي لحسابكم رقم (?<hint>\d{4}) بمبلغ (?<amount>${AMT}) جم من (?<name>.+?) رقم مرجعي (?<ref>\d{12}) يوم (?<d1>\d{2})-(?<d2>\d{2}) الساعه ?(?<time>\d{1,2}:\d{2})(?<tail>.*)$`,
  ),
  dateOrder: ["MD"],
  hasYear: false,
  hasBalance: false,
  referenceFormat: "digits12",
  footerDomains: [],
  autoConfirm: "reference",
  status: "published_sample",
  sampleIds: ["IP-NBE-1"],
};

/** IP-NBE-2: InstaPay credit to a prepaid (Meeza) card — no digits, routed only to a single prepaid account. */
export const NBE_SMS_PREPAID_CREDIT_V1: CollectionTemplate = {
  id: "nbe.sms.prepaid_credit.v1",
  provider: "nbe",
  rail: "instapay",
  channel: "sms",
  direction: "credit",
  locale: "ar",
  version: 1,
  senderIds: SENDERS,
  packages: [],
  regex: re(
    String.raw`^تم اضافه تحويل لحظي لبطاقتكم مسبقه الدفع بمبلغ (?<amount>${AMT}) جم من (?<name>.+?) رقم مرجعي (?<ref>\d{12}) يوم (?<d1>\d{2})-(?<d2>\d{2}) الساعه ?(?<time>\d{1,2}:\d{2})(?<tail>.*)$`,
  ),
  dateOrder: ["MD"],
  hasYear: false,
  hasBalance: false,
  referenceFormat: "digits12",
  routesToPrepaidCard: true,
  footerDomains: [],
  autoConfirm: "reference",
  status: "published_sample",
  sampleIds: ["IP-NBE-2a", "IP-NBE-2b"],
};

/** IP-NBE-3: InstaPay debit (the payer's side). */
export const NBE_SMS_DEBIT_V1: CollectionTemplate = {
  id: "nbe.sms.debit.v1",
  provider: "nbe",
  rail: "instapay",
  channel: "sms",
  direction: "debit",
  locale: "ar",
  version: 1,
  senderIds: SENDERS,
  packages: [],
  regex: re(
    String.raw`^تم تنفيذ تحويل لحظي من حسابكم رقم (?<hint>\d{4}) بمبلغ (?<amount>${AMT}) جم الي (?<counterparty>.+?) رقم مرجعي (?<ref>\d{12}) يوم (?<d1>\d{2})-(?<d2>\d{2}) الساعه ?(?<time>\d{1,2}:\d{2})(?<tail>.*)$`,
  ),
  dateOrder: ["MD"],
  hasYear: false,
  hasBalance: false,
  referenceFormat: "digits12",
  footerDomains: [],
  autoConfirm: "never",
  status: "published_sample",
  sampleIds: ["IP-NBE-3"],
};

/** IP-NBE-4: IPN merchant / bill payment (debit). "الساعة11:42" has no space in the sample. */
export const NBE_SMS_MERCHANT_DEBIT_V1: CollectionTemplate = {
  id: "nbe.sms.merchant_debit.v1",
  provider: "nbe",
  rail: "instapay",
  channel: "sms",
  direction: "debit",
  locale: "ar",
  version: 1,
  senderIds: SENDERS,
  packages: [],
  regex: re(
    String.raw`^تم خصم مبلغ (?<amount>${AMT}) جم لحظيا باستخدام \(شبكه المدفوعات اللحظيه\) من حسابكم رقم (?<hint>\d{4}) عند (?<counterparty>.+?) يوم (?<d1>\d{2})-(?<d2>\d{2}) الساعه ?(?<time>\d{1,2}:\d{2}) مرجع التاجر (?<ref>\d{10})(?<tail>.*)$`,
  ),
  dateOrder: ["MD"],
  hasYear: false,
  hasBalance: false,
  referenceFormat: "digits10",
  footerDomains: [],
  autoConfirm: "never",
  status: "published_sample",
  sampleIds: ["IP-NBE-4"],
};

export const NBE_TEMPLATES: readonly CollectionTemplate[] = [
  NBE_SMS_CREDIT_V1,
  NBE_SMS_PREPAID_CREDIT_V1,
  NBE_SMS_DEBIT_V1,
  NBE_SMS_MERCHANT_DEBIT_V1,
];
