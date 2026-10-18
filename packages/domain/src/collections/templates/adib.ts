// ADIB Egypt SMS template (spec 06 §4.10). Seeded ONLY from the published
// debit sample IP-ADIB-1 ([MATTIYA]; hotline 19951, [ADIB]),
// _research/instapay.md §4.3. The ADIB credit wording was not found, so only
// the debit exists. The sender id is unobserved (senderIds []).
import { COLLECTION_PROVIDERS } from "../providers";
import type { CollectionTemplate } from "../types";
import { AMT, re } from "./_shared";

export const ADIB_SMS_DEBIT_V1: CollectionTemplate = {
  id: "adib.sms.debit.v1",
  provider: "adib",
  rail: "instapay",
  channel: "sms",
  direction: "debit",
  locale: "en",
  version: 1,
  senderIds: COLLECTION_PROVIDERS.adib.smsSenderIds,
  packages: [],
  regex: re(
    String.raw`^Your account ending in (?<hint>\d{4}) has been charged the amount of (?<amount>${AMT}) for an IPN transfer on (?<d1>\d{4})-(?<d2>\d{2})-(?<d3>\d{2}) (?<time>\d{1,2}:\d{2}) Txn Ref: (?<ref>[0-9a-f]{8})(?<tail>.*)$`,
  ),
  dateOrder: ["YMD"],
  hasYear: true,
  hasBalance: false,
  referenceFormat: "hex8",
  footerDomains: [],
  autoConfirm: "never",
  status: "published_sample",
  sampleIds: ["IP-ADIB-1"],
};

export const ADIB_TEMPLATES: readonly CollectionTemplate[] = [ADIB_SMS_DEBIT_V1];
