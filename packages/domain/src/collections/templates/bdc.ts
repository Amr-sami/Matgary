// Banque du Caire SMS template (spec 06 §4.10). Seeded ONLY from the published
// sample IP-BDC-1 ([MATTIYA]; the bank is inferred from the hotline 16990,
// [BDC]), _research/instapay.md §4.3. The sender id is unknown (I6), so
// senderIds is [] and the template can never auto-confirm.
import { COLLECTION_PROVIDERS } from "../providers";
import type { CollectionTemplate } from "../types";
import { AMT, re } from "./_shared";

export const BDC_SMS_CREDIT_V1: CollectionTemplate = {
  id: "bdc.sms.credit.v1",
  provider: "bdc",
  rail: "instapay",
  channel: "sms",
  direction: "credit",
  locale: "ar",
  version: 1,
  senderIds: COLLECTION_PROVIDERS.bdc.smsSenderIds,
  packages: [],
  regex: re(
    String.raw`^تم استقبال تحويل لحظي الي حسابكم (?<hint>\d{4}) بمبلغ (?<amount>${AMT}) جم من (?<name>.+?) في (?<time>\d{1,2}:\d{2}) يوم (?<d1>\d{1,2})/(?<d2>\d{1,2})/(?<d3>\d{2}) رقم المعامله (?<ref>[0-9a-f]{8})(?<tail>.*)$`,
  ),
  dateOrder: ["MDY"],
  hasYear: true,
  hasBalance: false,
  referenceFormat: "hex8",
  footerDomains: [],
  autoConfirm: "never",
  status: "published_sample",
  sampleIds: ["IP-BDC-1"],
};

export const BDC_TEMPLATES: readonly CollectionTemplate[] = [BDC_SMS_CREDIT_V1];
