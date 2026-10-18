// CIB SMS templates (spec 06 §4.10). Seeded ONLY from the published samples
// IP-CIB-1 ([ZEN]) and its debit ([FINFAST]), _research/instapay.md §4.3.
// Trap: credit and debit share the opening words and differ only in
// "الي حسابك" (credit) against "من حسابك" (debit).
import { COLLECTION_PROVIDERS } from "../providers";
import type { CollectionTemplate } from "../types";
import { AMT, re } from "./_shared";

const SENDERS = COLLECTION_PROVIDERS.cib.smsSenderIds;

export const CIB_SMS_CREDIT_V1: CollectionTemplate = {
  id: "cib.sms.credit.v1",
  provider: "cib",
  rail: "instapay",
  channel: "sms",
  direction: "credit",
  locale: "ar",
  version: 1,
  senderIds: SENDERS,
  packages: [],
  regex: re(
    String.raw`^يرجي العلم انه تم تنفيذ تحويل لحظي بمبلغ (?<amount>${AMT}) جم الي حسابك المنتهي ب ?\*+(?<hint>\d{4}) من (?<name>.+?) برقم مرجعي (?<ref>[0-9a-f]{8}) بتاريخ (?<d1>\d{2})-(?<d2>\d{2})-(?<d3>\d{4}) (?<time>\d{1,2}:\d{2})(?<tail>.*)$`,
  ),
  dateOrder: ["DMY"],
  hasYear: true,
  hasBalance: false,
  referenceFormat: "hex8",
  footerDomains: [],
  autoConfirm: "reference",
  status: "published_sample",
  sampleIds: ["IP-CIB-1"],
};

export const CIB_SMS_DEBIT_V1: CollectionTemplate = {
  id: "cib.sms.debit.v1",
  provider: "cib",
  rail: "instapay",
  channel: "sms",
  direction: "debit",
  locale: "ar",
  version: 1,
  senderIds: SENDERS,
  packages: [],
  regex: re(
    String.raw`^يرجي العلم انه تم تنفيذ تحويل لحظي بمبلغ (?<amount>${AMT}) جم من حسابك المنتهي ب ?\*+(?<hint>\d{4}) برقم مرجعي (?<ref>[0-9a-f]{8}) بتاريخ (?<d1>\d{2})-(?<d2>\d{2})-(?<d3>\d{4}) (?<time>\d{1,2}:\d{2})(?<tail>.*)$`,
  ),
  dateOrder: ["DMY"],
  hasYear: true,
  hasBalance: false,
  referenceFormat: "hex8",
  footerDomains: [],
  autoConfirm: "never",
  status: "published_sample",
  sampleIds: ["IP-CIB-1-D"],
};

export const CIB_TEMPLATES: readonly CollectionTemplate[] = [CIB_SMS_CREDIT_V1, CIB_SMS_DEBIT_V1];
