// Digital collections (InstaPay + mobile wallets) — the shared vocabulary.
//
// Every union of 03-architecture.md §B.1 lives here, each as a `readonly` value
// array plus its type, so that:
//   - the server builds zod enums from the arrays (spec 05),
//   - the migration pin tests compare the arrays with the SQL CHECK lists
//     (spec 04),
//   - web and mobile share one set of names.
// The ORDER of every array is the order of §B.1 and is pinned by
// __tests__/types.test.ts. Never reorder a list; append a value only after
// 03 §B.1 has it.
//
// Also here (types only, no runtime): the template, parser and matcher I/O
// shapes of spec 06 §4.10–§4.13, so spec 07 imports every type from one path.
//
// Hermes-safe: no regex, no Intl, no String.prototype.normalize (see
// __tests__/hermes-safe.test.ts). This file must never import `next/*`,
// React, React Native or a database client.

// ---------------------------------------------------------------------------
// §B.1 unions
// ---------------------------------------------------------------------------

/** `sales.payment_method` (zod only; no DB CHECK). */
export const PAYMENT_METHOD_VALUES = ["cash", "instapay", "wallet", "card", "deferred"] as const;
export type PaymentMethod = (typeof PAYMENT_METHOD_VALUES)[number];

/** `collections.method` (CHECK). */
export const DIGITAL_METHOD_VALUES = ["instapay", "wallet"] as const;
export type DigitalMethod = (typeof DIGITAL_METHOD_VALUES)[number];

/** The settle body's method (zod). */
export const SETTLEMENT_METHOD_VALUES = ["cash", "instapay", "wallet", "card"] as const;
export type SettlementMethod = (typeof SETTLEMENT_METHOD_VALUES)[number];

/** `sale_payments.method` (CHECK `sale_payments_method_check`, re-created in 0055). */
export const SALE_PAYMENT_METHOD_VALUES = ["cash", "instapay", "wallet", "card", "initial"] as const;
export type SalePaymentMethod = (typeof SALE_PAYMENT_METHOD_VALUES)[number];

/** `collection_accounts.rail` (CHECK). */
export const COLLECTION_RAIL_VALUES = ["instapay", "wallet"] as const;
export type CollectionRail = (typeof COLLECTION_RAIL_VALUES)[number];

/**
 * `collection_accounts.provider` (zod + the registry in providers.ts; no CHECK,
 * so a bank can be added without a migration). Rail `instapay` first, then
 * rail `wallet`, as in §B.1.
 */
export const COLLECTION_PROVIDER_VALUES = [
  // rail instapay
  "nbe",
  "cib",
  "qnb",
  "banque_misr",
  "bdc",
  "aaib",
  "alexbank",
  "hsbc",
  "faisal",
  "adib",
  "other_bank",
  // rail wallet
  "vodafone_cash",
  "etisalat_money",
  "orange_cash",
  "we_pay",
  "nbe_phone_cash",
  "bm_wallet",
  "other_wallet",
] as const;
export type CollectionProvider = (typeof COLLECTION_PROVIDER_VALUES)[number];

/** `collections.status` (CHECK). */
export const COLLECTION_STATUS_VALUES = ["pending", "confirmed", "auto_confirmed", "rejected", "void"] as const;
export type CollectionStatus = (typeof COLLECTION_STATUS_VALUES)[number];

/** `sales.collection_status` (CHECK; NULL = not a digital sale). */
export const SALE_COLLECTION_STATUS_VALUES = ["pending", "confirmed", "rejected"] as const;
export type SaleCollectionStatus = (typeof SALE_COLLECTION_STATUS_VALUES)[number];

/** `collections.source_type` (CHECK). */
export const COLLECTION_SOURCE_TYPE_VALUES = ["sale", "settlement"] as const;
export type CollectionSourceType = (typeof COLLECTION_SOURCE_TYPE_VALUES)[number];

/** `collections.reject_reason` (CHECK). */
export const REJECT_REASON_VALUES = ["not_received", "wrong_amount", "wrong_account", "duplicate", "other"] as const;
export type RejectReason = (typeof REJECT_REASON_VALUES)[number];

/** `collections.reject_outcome` (CHECK). */
export const REJECT_OUTCOME_VALUES = ["debt", "loss"] as const;
export type RejectOutcome = (typeof REJECT_OUTCOME_VALUES)[number];

/**
 * `collections.flags text[]` (zod only). `via_provider` is written only by L3
 * (M6, spec 17, 03 §B.1 via 17's ARCH CHANGE REQUEST 9).
 */
export const COLLECTION_FLAG_VALUES = [
  "account_inactive",
  "account_missing",
  "parts_clamped",
  "total_changed",
  "returned",
  "offline_rung",
  "via_provider",
] as const;
export type CollectionFlag = (typeof COLLECTION_FLAG_VALUES)[number];

/**
 * `DeviceDTO.health`, computed by spec 07 `deviceHealth`. Listed in §B.1 order;
 * the priority (revoked → listener_off → silent → heartbeat_late → never_seen
 * → ok) is applied by 07, not encoded in this order.
 */
export const DEVICE_HEALTH_VALUES = ["ok", "never_seen", "silent", "listener_off", "heartbeat_late", "revoked"] as const;
export type DeviceHealth = (typeof DEVICE_HEALTH_VALUES)[number];

/** Summary `limitWarnings` (§B.17); output order of limits.ts `limitWarnings()`. */
export const LIMIT_WARNING_VALUES = ["day_80", "month_80", "new_wallet_day_80", "balance_90"] as const;
export type LimitWarning = (typeof LIMIT_WARNING_VALUES)[number];

/** `collection_events.kind` (CHECK). */
export const COLLECTION_EVENT_KIND_VALUES = [
  "created",
  "matched",
  "auto_confirmed",
  "confirmed",
  "rejected",
  "reopened",
  "voided",
  "amount_changed",
  "account_changed",
  "evidence_attached",
  "stale_alerted",
  "note",
] as const;
export type CollectionEventKind = (typeof COLLECTION_EVENT_KIND_VALUES)[number];

/** Raw messages and credits (CHECK). `statement` is reserved (never sent). */
export const INGEST_CHANNEL_VALUES = [
  "ios_notification",
  "ios_sms",
  "android_notification",
  "android_sms",
  "manual_paste",
  "statement",
] as const;
export type IngestChannel = (typeof INGEST_CHANNEL_VALUES)[number];

/** `collection_ingest_devices.platform` (CHECK). */
export const INGEST_PLATFORM_VALUES = ["ios_shortcut", "ios_app_intent", "android_listener", "android_collector"] as const;
export type IngestPlatform = (typeof INGEST_PLATFORM_VALUES)[number];

/** Raw messages and credits (CHECK). */
export const SENDER_KIND_VALUES = ["alphanumeric", "numeric", "app"] as const;
export type SenderKind = (typeof SENDER_KIND_VALUES)[number];

/** `collection_credits.direction` (CHECK). */
export const CREDIT_DIRECTION_VALUES = ["credit", "debit", "cash_in"] as const;
export type CreditDirection = (typeof CREDIT_DIRECTION_VALUES)[number];

/** `collection_credits.state` (CHECK). */
export const CREDIT_STATE_VALUES = ["unmatched", "held", "matched", "ignored", "info"] as const;
export type CreditState = (typeof CREDIT_STATE_VALUES)[number];

/** `collection_credits.hold_reason` (CHECK). 14 values. */
export const HOLD_REASON_VALUES = [
  "ambiguous",
  "untrusted_source",
  "balance_mismatch",
  "no_balance_baseline",
  "above_review_limit",
  "no_account",
  "unverified_format",
  "manual_source",
  "suspicious_link",
  "too_old",
  "amount_mismatch",
  "auto_confirm_off",
  "matches_rejected",
  "test",
] as const;
export type HoldReason = (typeof HOLD_REASON_VALUES)[number];

/** `collection_credits.ignored_reason` (CHECK). */
export const IGNORE_REASON_VALUES = ["personal", "not_a_sale", "duplicate", "other"] as const;
export type IgnoreReason = (typeof IGNORE_REASON_VALUES)[number];

/** `collection_raw_messages.parse_status` (CHECK). 7 values. */
export const PARSE_STATUS_VALUES = [
  "parsed",
  "fallback",
  "unknown_format",
  "not_credit",
  "otp",
  "too_old",
  "duplicate",
] as const;
export type ParseStatus = (typeof PARSE_STATUS_VALUES)[number];

/** Ingest `results[].reason` = `ParseStatus` ∪ `channel_not_allowed`. */
export const INGEST_RESULT_REASON_VALUES = [...PARSE_STATUS_VALUES, "channel_not_allowed"] as const;
export type IngestResultReason = (typeof INGEST_RESULT_REASON_VALUES)[number];

/** Domain template registry (no DB column). */
export const TEMPLATE_AUTO_CONFIRM_VALUES = ["balance", "reference", "never"] as const;
export type TemplateAutoConfirm = (typeof TEMPLATE_AUTO_CONFIRM_VALUES)[number];

/** Domain template registry; auto-confirm requires `pilot_verified` (§D.5). */
export const TEMPLATE_STATUS_VALUES = ["published_sample", "pilot_verified"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUS_VALUES)[number];

// ---------------------------------------------------------------------------
// Helpers over the unions
// ---------------------------------------------------------------------------

/** The two methods that create a pending collection (05 cart, 08/12 panel). */
export const DIGITAL_METHODS: ReadonlySet<PaymentMethod> = new Set<PaymentMethod>(["instapay", "wallet"]);

export function isDigitalMethod(m: string): m is DigitalMethod {
  return m === "instapay" || m === "wallet";
}

// ---------------------------------------------------------------------------
// Templates (spec 06 §4.10) — types only; the registry is part B.
// ---------------------------------------------------------------------------

export type TemplateChannel = "sms" | "notification";
export type DateOrder = "YMD" | "DMY" | "MDY" | "MD" | "DM";
export type ReferenceFormat = "digits12" | "hex8" | "digits10" | "none";

export interface CollectionTemplate {
  /** "<provider-or-family>.<channel>.<kind>.v<n>", e.g. `nbe.sms.credit.v1`. */
  id: string;
  provider: CollectionProvider;
  rail: CollectionRail;
  channel: TemplateChannel;
  direction: CreditDirection;
  locale: "ar" | "en";
  version: number;
  /** = COLLECTION_PROVIDERS[provider].smsSenderIds for SMS templates. */
  senderIds: readonly string[];
  /** Notification templates only (Android package id = iOS source label). */
  packages: readonly string[];
  /** Applied to normalizeText(messageText); flags "is"; anchored ^…$. */
  regex: RegExp;
  /** Candidate orders for groups d1,d2,d3 in text order; [] = no usable date. */
  dateOrder: readonly DateOrder[];
  hasYear: boolean;
  hasBalance: boolean;
  referenceFormat: ReferenceFormat;
  /** NBE prepaid: the message carries no account digits (IP-NBE-2). */
  routesToPrepaidCard?: true;
  /** Hosts allowed in the text (and their subdomains). */
  footerDomains: readonly string[];
  autoConfirm: TemplateAutoConfirm;
  status: TemplateStatus;
  sampleIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Parser I/O (spec 06 §4.11) — types only; parse.ts is part B.
// ---------------------------------------------------------------------------

export interface ParseInput {
  channel: IngestChannel;
  sender?: string | null;
  sourceApp?: string | null;
  title?: string | null;
  subtitle?: string | null;
  body: string;
  receivedAt: Date | string;
}

export interface ParsedFields {
  /** Decimal string, 2 places ("2700.00"). */
  amount: string;
  currency: "EGP";
  /** National form 01XXXXXXXXX (§D.2); credits only. */
  payerPhone: string | null;
  /** Credits only. */
  payerName: string | null;
  balanceAfter: string | null;
  /** Lower-case. */
  reference: string | null;
  /** 4 digits. */
  receivingHint: string | null;
  /** ISO string with Z. */
  occurredAt: string;
  occurredAtSource: "message" | "received";
}

export interface ParseResult {
  status: Exclude<ParseStatus, "duplicate">;
  templateId: string | null;
  provider: CollectionProvider | null;
  rail: CollectionRail | null;
  direction: CreditDirection | null;
  fields: ParsedFields | null;
  confidence: "exact" | "fallback" | null;
  senderKind: SenderKind;
  senderMatched: boolean;
  links: string[];
  suspiciousLinks: string[];
}

// ---------------------------------------------------------------------------
// Matcher I/O (spec 06 §4.13) — types only; match.ts is part B.
// ---------------------------------------------------------------------------

export interface MatchCredit {
  accountId: string | null;
  rail: CollectionRail | null;
  /** Decimal string. */
  amount: string;
  occurredAt: Date | string;
  operatorReference: string | null;
  operatorReferenceFormat: ReferenceFormat;
  payerPhoneLast4: string | null;
}

export interface MatchCollection {
  id: string;
  status: CollectionStatus;
  accountId: string | null;
  method: DigitalMethod;
  /** Decimal string. */
  amount: string;
  rungAt: Date | string;
  payerReference: string | null;
  payerPhoneLast4: string | null;
  /** Needed by classifyLateArrival (evidence vs matches_rejected). */
  matchedCreditId: string | null;
}

export interface RankedCandidate {
  collectionId: string;
  window: "auto" | "suggest";
  score: number;
  signals: ("reference" | "phone")[];
  conflict: boolean;
  /** occurredAt − rungAt, in minutes. */
  deltaMin: number;
  /** creditPt − collectionPt (0 for an exact amount). */
  overpayPt: number;
}

export type MatchDecision =
  | { kind: "auto"; collectionId: string }
  | { kind: "hold"; reason: "ambiguous" | "amount_mismatch"; suggestedCollectionId: string | null }
  | { kind: "unmatched"; suggestedCollectionId: string | null };

export type BalanceCheckOutcome = "pass" | "mismatch" | "no_baseline" | "breaks_chain" | "not_applicable";

export interface BalanceCheckResult {
  result: BalanceCheckOutcome;
  newBaseline: string | null;
}

export interface GateInput {
  /** features.collectionsAutoConfirm */
  autoConfirmFeature: boolean;
  account: { autoConfirmEnabled: boolean; reviewThreshold: string };
  template: CollectionTemplate | null;
  channel: IngestChannel;
  senderKind: SenderKind;
  senderMatched: boolean;
  device: { live: boolean; channels: readonly IngestChannel[] } | null;
  amount: string;
  occurredAt: Date | string;
  reference: string | null;
  suspiciousLinks: readonly string[];
  isTest: boolean;
  balance: BalanceCheckResult["result"];
  now: Date;
}

export interface GateResult {
  pass: boolean;
  /** = reasons[0] in the security-first priority, or null when pass. */
  reason: HoldReason | null;
  reasons: HoldReason[];
}

// Additional matcher I/O (spec 06 §4.13; additive, 06 ARCH CR 1) — the inputs
// of routeCredit / balanceCheck and the result of classifyLateArrival, kept
// here so spec 07 imports every type from one path.

/** An active, non-archived receiving account as routeCredit sees it. */
export interface RouteAccount {
  id: string;
  provider: CollectionProvider;
  rail: CollectionRail;
  accountLast4: string | null;
  walletMsisdn: string | null;
  isPrepaidCard: boolean;
}

export interface RouteCreditInput {
  /** null = a fallback credit (no template hit). */
  template: CollectionTemplate | null;
  receivingHint: string | null;
  accounts: readonly RouteAccount[];
  /** The device's `account_ids`; [] = every account. */
  deviceAccountIds: readonly string[];
}

export type RouteResult = { accountId: string } | { accountId: null; reason: "no_account" };

export interface BalanceCheckInput {
  /** collection_accounts.balance_check_enabled */
  enabled: boolean;
  template: CollectionTemplate | null;
  direction: CreditDirection;
  amount: string;
  balanceAfter: string | null;
  /** collection_accounts.balance_baseline */
  baseline: string | null;
  baselineAt: Date | string | null;
  /** collection_accounts.balance_chain_broken_at */
  chainBrokenAt: Date | string | null;
}

export type LateArrival =
  | { kind: "evidence"; collectionId: string }
  | { kind: "matches_rejected"; collectionId: string }
  | { kind: "none" };
