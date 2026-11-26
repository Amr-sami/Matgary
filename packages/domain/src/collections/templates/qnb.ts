// QNB (Egypt) SMS templates (spec 06 §4.10). Seeded ONLY from the published
// samples IP-QNB-1 / its debit ([ESLAM], a real 77-message export) and the
// pair debit IP-QNB-PAIR-D ([MATTIYA]), _research/instapay.md §4.3.
// DD/MM with no year, 12-hour clock, 8-hex reference, no payer name.
import { COLLECTION_PROVIDERS } from "../providers";
import type { CollectionTemplate } from "../types";
import { AMT, re } from "./_shared";

const SENDERS = COLLECTION_PROVIDERS.qnb.smsSenderIds;

export const QNB_SMS_CREDIT_V1: CollectionTemplate = {
  id: "qnb.sms.credit.v1",
  provider: "qnb",
  rail: "instapay",
  channel: "sms",
  direction: "credit",
  locale: "en",
  version: 1,
  senderIds: SENDERS,
  packages: [],
  regex: re(
    String.raw`^IPN transfer received with amount of EGP (?<amount>${AMT}) on (?<hint>\d{4}) on (?<d1>\d{2})/(?<d2>\d{2}) at (?<time>\d{1,2}:\d{2}) (?<ampm>AM|PM)\. Ref# (?<ref>[0-9a-f]{8})(?<tail>.*)$`,
  ),
  dateOrder: ["DM"],
  hasYear: false,
  hasBalance: false,
  referenceFormat: "hex8",
  footerDomains: [],
  autoConfirm: "reference",
  status: "published_sample",
  sampleIds: ["IP-QNB-1"],
};

export const QNB_SMS_DEBIT_V1: CollectionTemplate = {
  id: "qnb.sms.debit.v1",
  provider: "qnb",
  rail: "instapay",
  channel: "sms",
  direction: "debit",
  locale: "en",
  version: 1,
  senderIds: SENDERS,
  packages: [],
  regex: re(
    String.raw`^IPN transfer sent with amount of EGP (?<amount>${AMT}) from (?<hint>\d{4}) on (?<d1>\d{2})/(?<d2>\d{2}) at (?<time>\d{1,2}:\d{2}) (?<ampm>AM|PM)\. Ref# (?<ref>[0-9a-f]{8})(?<tail>.*)$`,
  ),
  dateOrder: ["DM"],
  hasYear: false,
  hasBalance: false,
  referenceFormat: "hex8",
  footerDomains: [],
  autoConfirm: "never",
  status: "published_sample",
  sampleIds: ["IP-QNB-1-D", "IP-QNB-PAIR-D"],
};

export const QNB_TEMPLATES: readonly CollectionTemplate[] = [QNB_SMS_CREDIT_V1, QNB_SMS_DEBIT_V1];
