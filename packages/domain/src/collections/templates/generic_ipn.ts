// An unidentified bank's InstaPay credit (spec 06 §4.10). Seeded ONLY from the
// published sample IP-UNK-1 ([MATTIYA]), _research/instapay.md §4.3. The
// weakest template: no reference, no time, no name, sender unknown, so it is
// filed under provider `other_bank` and never auto-confirms. The date
// ("19-AUG-2026") is captured as `datetext` only; occurredAt = receivedAt.
import { COLLECTION_PROVIDERS } from "../providers";
import type { CollectionTemplate } from "../types";
import { AMT, re } from "./_shared";

export const GENERIC_IPN_SMS_CREDIT_V1: CollectionTemplate = {
  id: "generic_ipn.sms.credit.v1",
  provider: "other_bank",
  rail: "instapay",
  channel: "sms",
  direction: "credit",
  locale: "ar",
  version: 1,
  senderIds: COLLECTION_PROVIDERS.other_bank.smsSenderIds,
  packages: [],
  regex: re(
    String.raw`^تم اضافه مبلغ (?<amount>${AMT}) ?EGP الي حساب رقم x*(?<hint>\d{4}) في (?<datetext>\d{1,2}-[a-z]{3}-\d{4}) عن طريق التحويل اللحظي(?<tail>.*)$`,
  ),
  dateOrder: [],
  hasYear: false,
  hasBalance: false,
  referenceFormat: "none",
  footerDomains: [],
  autoConfirm: "never",
  status: "published_sample",
  sampleIds: ["IP-UNK-1"],
};

export const GENERIC_IPN_TEMPLATES: readonly CollectionTemplate[] = [GENERIC_IPN_SMS_CREDIT_V1];
