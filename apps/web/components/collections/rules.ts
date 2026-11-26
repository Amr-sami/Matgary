// Digital collections — the web's pure rules (doc 15 spec 12 §4.2).
//
// No React, no next/*, no fetch: type-only imports, pure functions from
// @matgary/domain/collections/* and `can()` from lib/permissions.ts (a module
// with no imports of its own). Unit-tested by
// tests/unit/collections-web-rules.test.ts. The phone keeps its own copy of the
// same rules (08 §4.2–§4.4, 09 §4.4); the SERVER stays the authority for every
// gate here — these only decide what the UI offers.
//
// Money is done in integer piasters (domain `toPiasters`; a throw = invalid).

import type {
  CollectionAccountDTO,
  CollectionDTO,
  CollectionStatus,
  ListCollectionsParams,
  RejectOutcome,
  SaleCollectionStatus,
} from "@matgary/api-client/endpoints/collections";
import type { CollectionsFeatures } from "@matgary/api-client/endpoints/me";
import type { CollectionProvider, CollectionRail, DeviceHealth } from "@matgary/domain/collections/types";
import {
  normalizeDigits,
  normalizeIban,
  normalizeWalletMsisdn,
  toPiasters,
} from "@matgary/domain/collections/normalize";
import { instapayPartWarning } from "@matgary/domain/collections/limits";
import { ipaHandleFromLink, ipaLinkFromShareText, isValidIpaLink } from "@matgary/domain/collections/ipa";
import { COLLECTION_PROVIDERS } from "@matgary/domain/collections/providers";
import { can, type PermissionPrincipal } from "@/lib/permissions";
import type { PaymentMethod } from "@/lib/types";

// ---------------------------------------------------------------------------
// Features and access
// ---------------------------------------------------------------------------

/** Every flag false: an old server, a failed config call, nothing cached. */
export const NO_FEATURES: Readonly<CollectionsFeatures> = Object.freeze({
  collections: false,
  collectionsIngest: false,
  collectionsAutoConfirm: false,
  collectionsProviders: false,
  collectionsAvailable: false,
});

export interface CollectionsAccess {
  isOwner: boolean;
  userId: string | null;
  canView: boolean;
  /** 03 §B.5 client rule: confirm_collections only counts WITH view_collections
   *  (the detail GET needs view); the owner passes both. */
  canConfirm: boolean;
  canManage: boolean;
}

/** The five permission fields of `useCollectionsAccess()` (12 §4.2). */
export function collectionsAccess(
  principal: PermissionPrincipal | null | undefined,
  userId: string | null | undefined,
): CollectionsAccess {
  if (!principal) {
    return { isOwner: false, userId: userId ?? null, canView: false, canConfirm: false, canManage: false };
  }
  const canView = can(principal, "view_collections");
  return {
    isOwner: principal.role === "owner",
    userId: userId ?? null,
    canView,
    canConfirm: can(principal, "confirm_collections") && canView,
    canManage: can(principal, "manage_collection_accounts"),
  };
}

// ---------------------------------------------------------------------------
// Method grids
// ---------------------------------------------------------------------------

export type DigitalMethod = "instapay" | "wallet";
export type SettleMethod = "cash" | "instapay" | "wallet" | "card";

export function isDigital(m: string | null | undefined): m is DigitalMethod {
  return m === "instapay" || m === "wallet";
}

/** POS chips: feature off = today's four, in today's order (SaleForm). */
export function methodsFor(on: boolean): PaymentMethod[] {
  return on ? ["cash", "instapay", "wallet", "card", "deferred"] : ["cash", "instapay", "card", "deferred"];
}

/** Settle modal chips (InvoiceSettleModal). */
export function settleMethodsFor(on: boolean): SettleMethod[] {
  return on ? ["cash", "instapay", "wallet", "card"] : ["cash", "instapay", "card"];
}

// ---------------------------------------------------------------------------
// Accounts on the POS
// ---------------------------------------------------------------------------

export type AccountLike = Pick<
  CollectionAccountDTO,
  | "id"
  | "branchId"
  | "rail"
  | "provider"
  | "label"
  | "ipaHandle"
  | "ipaLink"
  | "accountLast4"
  | "walletMsisdn"
  | "isPosDefault"
  | "sortOrder"
  | "archivedAt"
> &
  Partial<Pick<CollectionAccountDTO, "holderName" | "mask" | "isPrepaidCard">>;

function byPosOrder(a: AccountLike, b: AccountLike): number {
  if (a.isPosDefault !== b.isPosDefault) return a.isPosDefault ? -1 : 1;
  if ((a.sortOrder ?? 0) !== (b.sortOrder ?? 0)) return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  return a.label.localeCompare(b.label);
}

/**
 * The accounts a digital method offers on the POS (08 §4.2 item 1, 03 §C.1):
 * active, of this branch or every branch; `instapay` lists every digital
 * account (InstaPay can pay a wallet) with the InstaPay rail first; `wallet`
 * lists the wallet rail only. Within a rail: POS default, sortOrder, label.
 */
export function accountsForMethod<A extends AccountLike>(
  accounts: readonly A[],
  method: PaymentMethod | string,
  branchId: string | null | undefined,
): A[] {
  if (!isDigital(method)) return [];
  const live = accounts.filter(
    (a) => a.archivedAt == null && (a.branchId == null || a.branchId === branchId),
  );
  const bank = live.filter((a) => a.rail === "instapay").sort(byPosOrder);
  const wallets = live.filter((a) => a.rail === "wallet").sort(byPosOrder);
  return method === "instapay" ? [...bank, ...wallets] : wallets;
}

/** The POS-default account of the method's rail; else the only listed one. */
export function defaultAccountFor<A extends AccountLike>(listed: readonly A[], method: PaymentMethod | string): A | null {
  if (!isDigital(method)) return null;
  const rail: CollectionRail = method;
  const def = listed.find((a) => a.rail === rail && a.isPosDefault);
  if (def) return def;
  return listed.length === 1 ? listed[0] : null;
}

/** "+201012345678" / "01012345678" → "010 1234 5678"; anything else as is. */
export function formatWalletNumber(msisdn: string): string {
  const d = normalizeDigits(msisdn).replace(/[^0-9]/g, "");
  const national = d.startsWith("20") && d.length === 12 ? `0${d.slice(2)}` : d;
  if (/^01\d{9}$/.test(national)) {
    return `${national.slice(0, 3)} ${national.slice(3, 7)} ${national.slice(7)}`;
  }
  return msisdn;
}

/** What the POS shows to identify an account. Never the IBAN (03 §E.5). */
export function accountIdentity(a: Partial<AccountLike> | null | undefined): string {
  if (!a) return "";
  if (a.ipaHandle) return a.ipaHandle;
  if (a.walletMsisdn) return formatWalletNumber(a.walletMsisdn);
  if (a.accountLast4) return `•••• ${a.accountLast4}`;
  return "";
}

// ---------------------------------------------------------------------------
// The transfer draft (POS + settle)
// ---------------------------------------------------------------------------

export interface PartDraft {
  accountId: string | null;
  /** As typed ("150", "99.5"). */
  amount: string;
  payerPhoneLast4: string;
  payerReference: string;
}

export interface TransferDraft {
  accountId: string | null;
  payerPhoneLast4: string;
  payerReference: string;
  /** [] = one transfer of the whole total. */
  parts: PartDraft[];
}

export const EMPTY_TRANSFER: Readonly<TransferDraft> = Object.freeze({
  accountId: null,
  payerPhoneLast4: "",
  payerReference: "",
  parts: [] as PartDraft[],
});

export const MAX_PARTS = 4;

/** Piasters, or null when not a valid non-negative amount. */
export function piastersOf(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  try {
    return toPiasters(v);
  } catch {
    return null;
  }
}

/** 15000 → "150", 9950 → "99.50". */
export function amountString(pt: number): string {
  const whole = Math.floor(pt / 100);
  const frac = pt % 100;
  return frac === 0 ? String(whole) : `${whole}.${frac < 10 ? "0" : ""}${frac}`;
}

function sumParts(parts: readonly PartDraft[]): number {
  let s = 0;
  for (const p of parts) s += piastersOf(p.amount) ?? 0;
  return s;
}

function totalPt(total: number): number {
  return piastersOf(Math.max(0, total)) ?? Math.round(Math.max(0, total) * 100);
}

/** Switch to parts mode: part 1 takes the current account, payer fields and
 *  the whole total (08 §4.2 item 6). */
export function startSplit(draft: TransferDraft, total: number, defaultId: string | null): TransferDraft {
  if (draft.parts.length > 0) return draft;
  return {
    ...draft,
    parts: [
      {
        accountId: draft.accountId ?? defaultId,
        amount: amountString(totalPt(total)),
        payerPhoneLast4: draft.payerPhoneLast4,
        payerReference: draft.payerReference,
      },
    ],
  };
}

/** Append a part of max(0, total − Σ) (entering parts mode first), up to 4. */
export function addPart(draft: TransferDraft, total: number, defaultId: string | null): TransferDraft {
  const base = draft.parts.length === 0 ? startSplit(draft, total, defaultId) : draft;
  if (base.parts.length >= MAX_PARTS) return base;
  const rest = Math.max(0, totalPt(total) - sumParts(base.parts));
  return {
    ...base,
    parts: [...base.parts, { accountId: defaultId, amount: amountString(rest), payerPhoneLast4: "", payerReference: "" }],
  };
}

/** Remove part `n` (1-based). One part left whose amount equals the total
 *  collapses back to single mode (its account and payer fields move up). */
export function removePart(draft: TransferDraft, n: number, total: number): TransferDraft {
  if (n < 1 || n > draft.parts.length) return draft;
  const parts = draft.parts.filter((_, i) => i !== n - 1);
  if (parts.length === 0) return { ...draft, parts: [] };
  if (parts.length === 1 && piastersOf(parts[0].amount) === totalPt(total)) {
    const p = parts[0];
    return { accountId: p.accountId, payerPhoneLast4: p.payerPhoneLast4, payerReference: p.payerReference, parts: [] };
  }
  return { ...draft, parts };
}

/** total − Σparts in piasters (≥ 0); 0 in single mode. */
export function cashRemainder(total: number, draft: TransferDraft): number {
  if (draft.parts.length === 0) return 0;
  return Math.max(0, totalPt(total) - sumParts(draft.parts));
}

export type TransferErrorCode =
  | "account_required"
  | "part_amount_invalid"
  | "parts_exceed_total"
  | "too_many_parts"
  | "payer_last4_invalid"
  | "reference_invalid";
export type TransferWarningCode = "instapay_over_limit";

export interface TransferIssue<C extends string> {
  code: C;
  /** 1-based part, or null for the single transfer / the whole draft. */
  part: number | null;
}

export interface TransferValidation {
  errors: TransferIssue<TransferErrorCode>[];
  warnings: TransferIssue<TransferWarningCode>[];
}

const LAST4_RE = /^\d{4}$/;
const REFERENCE_RE = /^[0-9A-Za-z]{4,16}$/;

function checkPayer(
  last4: string,
  ref: string,
  part: number | null,
  errors: TransferIssue<TransferErrorCode>[],
): void {
  const l4 = normalizeDigits(last4).trim();
  if (l4 !== "" && !LAST4_RE.test(l4)) errors.push({ code: "payer_last4_invalid", part });
  const r = normalizeDigits(ref).trim();
  if (r !== "" && !REFERENCE_RE.test(r)) errors.push({ code: "reference_invalid", part });
}

/**
 * The client rules of 08 §4.4: errors block the record button, the warning
 * never does. `account_required` needs `requireAccount` AND a known list AND
 * ≥ 1 listed account. Parts always need an account (03 §B.17 pins
 * `collectionParts[].accountId` as required and the cart zod refuses a part
 * without one), so a split is offered only when an account is listed.
 */
export function validateTransfer(input: {
  method: PaymentMethod | string;
  draft: TransferDraft;
  total: number;
  listed: readonly AccountLike[];
  accountsKnown: boolean;
  requireAccount: boolean;
}): TransferValidation {
  const errors: TransferIssue<TransferErrorCode>[] = [];
  const warnings: TransferIssue<TransferWarningCode>[] = [];
  const { method, draft, total, listed, accountsKnown, requireAccount } = input;
  if (!isDigital(method)) return { errors, warnings };
  const needAccount = requireAccount && accountsKnown && listed.length > 0;

  if (draft.parts.length === 0) {
    if (needAccount && !draft.accountId) errors.push({ code: "account_required", part: null });
    checkPayer(draft.payerPhoneLast4, draft.payerReference, null, errors);
    if (method === "instapay" && total > 0 && instapayPartWarning(amountString(totalPt(total))) != null) {
      warnings.push({ code: "instapay_over_limit", part: null });
    }
    return { errors, warnings };
  }

  if (draft.parts.length > MAX_PARTS) errors.push({ code: "too_many_parts", part: null });
  let sum = 0;
  draft.parts.forEach((p, i) => {
    const n = i + 1;
    // Always: the server's part schema requires accountId (see above).
    if (!p.accountId) errors.push({ code: "account_required", part: n });
    const pt = piastersOf(p.amount);
    if (pt == null || pt <= 0) errors.push({ code: "part_amount_invalid", part: n });
    else {
      sum += pt;
      if (method === "instapay" && instapayPartWarning(amountString(pt)) != null) {
        warnings.push({ code: "instapay_over_limit", part: n });
      }
    }
    checkPayer(p.payerPhoneLast4, p.payerReference, n, errors);
  });
  if (sum > totalPt(total)) errors.push({ code: "parts_exceed_total", part: null });
  return { errors, warnings };
}

export interface CollectionCartOptions {
  collectionAccountId?: string;
  payerPhoneLast4?: string;
  payerReference?: string;
  collectionParts?: Array<{ accountId: string; amount: number; payerPhoneLast4?: string; payerReference?: string }>;
}

function payerFields(last4: string, ref: string): { payerPhoneLast4?: string; payerReference?: string } {
  const out: { payerPhoneLast4?: string; payerReference?: string } = {};
  const l4 = normalizeDigits(last4).trim();
  const r = normalizeDigits(ref).trim();
  if (l4 !== "") out.payerPhoneLast4 = l4;
  if (r !== "") out.payerReference = r;
  return out;
}

/**
 * What the cart POST / outbox carries (08 §4.3). Non-digital or feature off →
 * {}; single → `collectionAccountId` + non-empty payer fields; parts →
 * `collectionParts` only (no top-level account or payer fields). A part
 * without an account omits `accountId` (validateTransfer never lets one out).
 */
export function collectionOptionsFromDraft(
  method: PaymentMethod | string,
  draft: TransferDraft,
  featuresOn: boolean,
): CollectionCartOptions {
  if (!featuresOn || !isDigital(method)) return {};
  if (draft.parts.length === 0) {
    return {
      ...(draft.accountId ? { collectionAccountId: draft.accountId } : {}),
      ...payerFields(draft.payerPhoneLast4, draft.payerReference),
    };
  }
  return {
    collectionParts: draft.parts.map((p) => {
      const pt = piastersOf(p.amount) ?? 0;
      return {
        ...(p.accountId ? { accountId: p.accountId } : {}),
        amount: pt / 100,
        ...payerFields(p.payerPhoneLast4, p.payerReference),
      } as { accountId: string; amount: number; payerPhoneLast4?: string; payerReference?: string };
    }),
  };
}

// ---------------------------------------------------------------------------
// Inbox URL state
// ---------------------------------------------------------------------------

export const INBOX_TABS = ["pending", "credits", "confirmed", "rejected", "totals"] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

export interface InboxParams {
  tab: InboxTab;
  stale: boolean;
  invoice: string | null;
  id: string | null;
  credit: string | null;
  /** YYYY-MM-DD */
  date: string;
  allBranches: boolean;
}

interface ParamSource {
  get(name: string): string | null;
}

/** Local calendar day as YYYY-MM-DD. */
export function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${m < 10 ? "0" : ""}${m}-${day < 10 ? "0" : ""}${day}`;
}

function validYmd(s: string | null): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map((x) => parseInt(x, 10));
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * The inbox state from the URL (so every 03 §B.6 notification link works):
 * `tab` (default pending; `status=pending` → pending; `credits` without ingest
 * → pending), `stale=1`, `invoice`, `id`, `credit`, `date` (bad → today),
 * `branch=all` (owner only).
 */
export function parseInboxParams(
  sp: ParamSource,
  ingestOn: boolean,
  opts: { isOwner?: boolean; now?: Date } = {},
): InboxParams {
  const rawTab = sp.get("tab");
  let tab: InboxTab = "pending";
  if (rawTab && (INBOX_TABS as readonly string[]).includes(rawTab)) tab = rawTab as InboxTab;
  else if (sp.get("status") === "pending") tab = "pending";
  if (tab === "credits" && !ingestOn) tab = "pending";
  const date = sp.get("date");
  return {
    tab,
    stale: sp.get("stale") === "1",
    invoice: sp.get("invoice") || null,
    id: sp.get("id") || null,
    credit: ingestOn ? sp.get("credit") || null : null,
    date: validYmd(date) ? date : localYmd(opts.now ?? new Date()),
    allBranches: opts.isOwner === true && sp.get("branch") === "all",
  };
}

/** The `GET /api/collections` query of a list tab; null for totals/credits. */
export function listQueryFor(tab: InboxTab, p: Pick<InboxParams, "stale" | "invoice" | "allBranches">): ListCollectionsParams | null {
  let q: ListCollectionsParams;
  if (tab === "pending") q = { status: "pending", order: "asc", ...(p.stale ? { stale: true } : {}) };
  else if (tab === "confirmed") q = { status: "confirmed,auto_confirmed" };
  else if (tab === "rejected") q = { status: "rejected" };
  else return null;
  if (p.invoice) q.invoiceId = p.invoice;
  if (p.allBranches) q.branchId = "all";
  return q;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type DecideBlock = "status" | "permission" | "self";

/** Confirm / reject gate (03 §E.6 four-eyes; the owner is exempt). */
export function canDecide(
  c: Pick<CollectionDTO, "status" | "recordedBy">,
  who: Pick<CollectionsAccess, "canConfirm" | "isOwner" | "userId">,
): { allowed: boolean; reason: DecideBlock | null } {
  if (c.status !== "pending") return { allowed: false, reason: "status" };
  if (!who.canConfirm) return { allowed: false, reason: "permission" };
  if (!who.isOwner && c.recordedBy?.id != null && c.recordedBy.id === who.userId) {
    return { allowed: false, reason: "self" };
  }
  return { allowed: true, reason: null };
}

export const REOPEN_DAYS = 7;
const REOPEN_MS = REOPEN_DAYS * 86_400_000;

/** Owner, a decided status, and within 7 days of the decision (03 §C.8). */
export function reopenAllowed(
  c: Pick<CollectionDTO, "status" | "decidedAt">,
  isOwner: boolean,
  nowMs: number,
): boolean {
  if (!isOwner) return false;
  if (c.status !== "confirmed" && c.status !== "auto_confirmed" && c.status !== "rejected") return false;
  if (!c.decidedAt) return false;
  const at = new Date(c.decidedAt).getTime();
  if (!Number.isFinite(at)) return false;
  return nowMs - at <= REOPEN_MS;
}

/** The last moment a reopen is allowed, or null. */
export function reopenUntil(c: Pick<CollectionDTO, "decidedAt">): Date | null {
  if (!c.decidedAt) return null;
  const at = new Date(c.decidedAt).getTime();
  return Number.isFinite(at) ? new Date(at + REOPEN_MS) : null;
}

/** Q4: settlements always become debt; else debt when a phone is known. */
export function defaultRejectOutcome(c: Pick<CollectionDTO, "sourceType" | "customerPhone">): RejectOutcome {
  if (c.sourceType === "settlement") return "debt";
  return c.customerPhone ? "debt" : "loss";
}

// ---------------------------------------------------------------------------
// Pills and the ledger timeline
// ---------------------------------------------------------------------------

export interface SaleLike {
  paymentMethod?: PaymentMethod | string | null;
  isPaid?: boolean | null;
  collectionStatus?: SaleCollectionStatus | null;
}

/** The method pill tone (SalesTableRow's existing logic) plus the collection
 *  pill: pending / rejected only — confirmed is the normal, quiet state. */
export function salePills(sale: SaleLike): {
  methodTone: "deferred_unpaid" | "deferred_paid" | "default";
  collection: "pending" | "rejected" | null;
} {
  const methodTone =
    sale.paymentMethod === "deferred" ? (sale.isPaid ? "deferred_paid" : "deferred_unpaid") : "default";
  const cs = sale.collectionStatus;
  return { methodTone, collection: cs === "pending" || cs === "rejected" ? cs : null };
}

export type PillStatus = CollectionStatus | SaleCollectionStatus;

export function pillTone(status: PillStatus): string {
  switch (status) {
    case "pending":
      return "bg-orange-100 text-orange-700";
    case "confirmed":
    case "auto_confirmed":
      return "bg-success-light text-success";
    case "rejected":
      return "bg-danger-light text-danger";
    default:
      return "bg-gray-100 text-text-secondary";
  }
}

export interface PaymentEventLike {
  method: string;
  voidedAt?: string | Date | null;
  collectionId?: string | null;
  collectionStatus?: string | null;
}

/** One ledger / settle-history row: its label, struck-through state, pill. */
export function paymentEventView(
  ev: PaymentEventLike,
  labels: { methods: Partial<Record<string, string>>; initial: string },
): { label: string; struck: boolean; pill: "pending" | "rejected" | null; collectionId: string | null } {
  let label: string;
  if (ev.method === "initial") label = labels.initial;
  else if (ev.method === "cash" || ev.method === "instapay" || ev.method === "wallet" || ev.method === "card") {
    label = labels.methods[ev.method] ?? ev.method;
  } else label = ev.method;
  const struck = ev.voidedAt != null && ev.voidedAt !== "";
  const pill = struck ? "rejected" : ev.collectionStatus === "pending" ? "pending" : null;
  return { label, struck, pill, collectionId: ev.collectionId ?? null };
}

// ---------------------------------------------------------------------------
// The receiving-account form (09 §4.4 / §4.5 rules, 06 validators)
// ---------------------------------------------------------------------------

export interface AccountDraft {
  rail: CollectionRail;
  provider: CollectionProvider | "";
  label: string;
  holderName: string;
  /** The pasted InstaPay share text or the link itself. */
  ipaText: string;
  /** The stored handle when editing an account that has no link. */
  ipaHandle: string | null;
  accountLast4: string;
  isPrepaidCard: boolean;
  iban: string;
  walletMsisdn: string;
  walletOpenedOn: string;
  branchId: string | null;
  isPosDefault: boolean;
  isDefaultForMobile: boolean;
  autoConfirmEnabled: boolean;
  reviewThreshold: string;
  balanceCheckEnabled: boolean;
}

export function emptyAccountDraft(rail: CollectionRail, branchId: string | null = null): AccountDraft {
  return {
    rail,
    provider: "",
    label: "",
    holderName: "",
    ipaText: "",
    ipaHandle: null,
    accountLast4: "",
    isPrepaidCard: false,
    iban: "",
    walletMsisdn: "",
    walletOpenedOn: "",
    branchId,
    isPosDefault: false,
    isDefaultForMobile: false,
    autoConfirmEnabled: false,
    reviewThreshold: "",
    balanceCheckEnabled: true,
  };
}

export function draftFromDto(a: CollectionAccountDTO): AccountDraft {
  return {
    rail: a.rail,
    provider: a.provider,
    label: a.label,
    holderName: a.holderName ?? "",
    ipaText: a.ipaLink ?? "",
    ipaHandle: a.ipaHandle,
    accountLast4: a.accountLast4 ?? "",
    isPrepaidCard: a.isPrepaidCard,
    iban: a.iban ?? "",
    walletMsisdn: a.walletMsisdn ? formatWalletNumber(a.walletMsisdn) : "",
    walletOpenedOn: a.walletOpenedOn ?? "",
    branchId: a.branchId,
    isPosDefault: a.isPosDefault,
    isDefaultForMobile: a.isDefaultForMobile,
    autoConfirmEnabled: a.autoConfirmEnabled,
    reviewThreshold: a.reviewThreshold != null ? String(a.reviewThreshold) : "",
    balanceCheckEnabled: a.balanceCheckEnabled,
  };
}

/** Keys of `app.collectionsSettings.form.*` (the suffix after `form.`). */
export type AccountFormError =
  | "providerRequired"
  | "labelRequired"
  | "labelTooLong"
  | "holderNameTooLong"
  | "identityRequired"
  | "fields.ipaLink.invalid"
  | "fields.accountLast4.invalid"
  | "fields.iban.invalid"
  | "fields.iban.checksum"
  | "fields.walletMsisdn.invalid"
  | "fields.reviewThreshold.invalid";

/** The DB column (03 §B.2.1) each error sits under — the testID suffix too. */
export type AccountColumn =
  | "provider"
  | "label"
  | "holder_name"
  | "ipa_link"
  | "account_last4"
  | "iban"
  | "wallet_msisdn"
  | "wallet_opened_on"
  | "review_threshold"
  | "identity";

export type AccountDraftResult =
  | { ok: true; body: Record<string, unknown>; warnings: Array<"ipaLinkMissing"> }
  | { ok: false; errors: Partial<Record<AccountColumn, AccountFormError>> };

const EG_IBAN_SHAPE = /^EG\d{27}$/;
const THRESHOLD_RE = /^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/;

/** The ipa_link / handle the draft resolves to ("" text → nulls). */
export function ipaFromDraft(d: Pick<AccountDraft, "ipaText" | "ipaHandle">): {
  link: string | null;
  handle: string | null;
  invalid: boolean;
} {
  const text = d.ipaText.trim();
  if (text === "") return { link: null, handle: d.ipaHandle, invalid: false };
  const link = isValidIpaLink(text) ? text : ipaLinkFromShareText(text);
  if (!link) return { link: null, handle: null, invalid: true };
  return { link, handle: ipaHandleFromLink(link), invalid: false };
}

/**
 * 09 §4.4 rules on the web form. Returns the camelCase wire body (03 §B.17;
 * fields of the other rail are null, L2 fields only with `includeL2`) or the
 * errors keyed by column.
 */
export function validateAccountDraft(
  d: AccountDraft,
  opts: { includeL2: boolean; today: string },
): AccountDraftResult {
  const errors: Partial<Record<AccountColumn, AccountFormError>> = {};
  const warnings: Array<"ipaLinkMissing"> = [];
  const provider = d.provider;
  const info = provider ? COLLECTION_PROVIDERS[provider as CollectionProvider] : undefined;
  if (!provider || !info || info.rail !== d.rail) errors.provider = "providerRequired";

  const label = d.label.trim();
  if (label.length === 0) errors.label = "labelRequired";
  else if (label.length > 60) errors.label = "labelTooLong";
  const holder = d.holderName.trim();
  if (holder.length > 80) errors.holder_name = "holderNameTooLong";

  let ipaLink: string | null = null;
  let ipaHandle: string | null = null;
  let accountLast4: string | null = null;
  let iban: string | null = null;
  let walletMsisdn: string | null = null;
  let isPrepaidCard = false;

  if (d.rail === "instapay") {
    const ipa = ipaFromDraft(d);
    if (ipa.invalid) errors.ipa_link = "fields.ipaLink.invalid";
    ipaLink = ipa.link;
    ipaHandle = ipa.handle;
    if (!ipa.invalid && ipaLink == null) warnings.push("ipaLinkMissing");

    const l4 = normalizeDigits(d.accountLast4).trim();
    if (l4 !== "") {
      if (/^\d{4}$/.test(l4)) accountLast4 = l4;
      else errors.account_last4 = "fields.accountLast4.invalid";
    }
    const rawIban = normalizeDigits(d.iban).replace(/\s+/g, "").toUpperCase();
    if (rawIban !== "") {
      if (!EG_IBAN_SHAPE.test(rawIban)) errors.iban = "fields.iban.invalid";
      else {
        iban = normalizeIban(rawIban);
        if (iban == null) errors.iban = "fields.iban.checksum";
      }
    }
    isPrepaidCard = provider === "nbe" ? d.isPrepaidCard : false;
    const hasIdentity =
      ipaLink != null || ipaHandle != null || accountLast4 != null || iban != null || isPrepaidCard;
    if (!hasIdentity && !errors.ipa_link && !errors.account_last4 && !errors.iban) {
      errors.identity = "identityRequired";
    }
  } else {
    walletMsisdn = normalizeWalletMsisdn(d.walletMsisdn);
    if (walletMsisdn == null) errors.wallet_msisdn = "fields.walletMsisdn.invalid";
  }

  let walletOpenedOn: string | null = null;
  if (d.rail === "wallet" && d.walletOpenedOn.trim() !== "") {
    const v = d.walletOpenedOn.trim();
    // A future or malformed date is simply not sent (the input caps at today).
    if (validYmd(v) && v <= opts.today) walletOpenedOn = v;
  }

  let reviewThreshold: number | null = null;
  if (opts.includeL2 && d.reviewThreshold.trim() !== "") {
    const v = normalizeDigits(d.reviewThreshold).trim();
    if (!THRESHOLD_RE.test(v)) errors.review_threshold = "fields.reviewThreshold.invalid";
    else reviewThreshold = Number(v.replace(/,/g, ""));
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const body: Record<string, unknown> = {
    rail: d.rail,
    provider,
    label,
    holderName: holder === "" ? null : holder,
    ipaHandle: d.rail === "instapay" ? ipaHandle : null,
    ipaLink: d.rail === "instapay" ? ipaLink : null,
    accountLast4: d.rail === "instapay" ? accountLast4 : null,
    isPrepaidCard: d.rail === "instapay" ? isPrepaidCard : false,
    iban: d.rail === "instapay" ? iban : null,
    walletMsisdn: d.rail === "wallet" ? walletMsisdn : null,
    walletOpenedOn: d.rail === "wallet" ? walletOpenedOn : null,
    branchId: d.branchId,
    isPosDefault: d.isPosDefault,
    isDefaultForMobile: d.rail === "instapay" ? d.isDefaultForMobile : false,
  };
  if (opts.includeL2) {
    body.autoConfirmEnabled = d.autoConfirmEnabled;
    if (reviewThreshold != null) body.reviewThreshold = reviewThreshold;
    if (d.rail === "wallet") body.balanceCheckEnabled = d.balanceCheckEnabled;
  }
  return { ok: true, body, warnings };
}

/** The keys of `after` whose value differs from `before` (JSON equality). */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(after)) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(v ?? null)) out[k] = v;
  }
  return out;
}

/** The PATCH body of an edit: changed fields only, never rail / provider
 *  (05's PATCH schema has neither) nor the other rail's fields. */
export function accountPatchBody(before: AccountDraft, after: AccountDraft, includeL2: boolean, today: string) {
  const b = validateAccountDraft(before, { includeL2, today });
  const a = validateAccountDraft(after, { includeL2, today });
  if (!a.ok) return a;
  const beforeBody = b.ok ? b.body : {};
  const diff = changedFields(beforeBody, a.body);
  delete diff.rail;
  delete diff.provider;
  if (after.rail === "instapay") {
    delete diff.walletMsisdn;
    delete diff.walletOpenedOn;
  } else {
    for (const k of ["ipaHandle", "ipaLink", "accountLast4", "isPrepaidCard", "iban", "isDefaultForMobile"]) delete diff[k];
  }
  return { ok: true as const, body: diff, warnings: a.warnings };
}

// ---------------------------------------------------------------------------
// M2 — credits, unrecognised messages, linked phones (12 §4.2, §4.7, §4.8)
// ---------------------------------------------------------------------------

/**
 * `credit-match-<collectionId>` gate: `confirm_collections` (with view) and
 * the four-eyes hint of 07's candidate — nobody matches a credit to a sale
 * they recorded; the owner is exempt. The server re-checks (403
 * SELF_CONFIRM_FORBIDDEN).
 */
export function canMatch(
  candidate: { selfRecorded: boolean },
  who: Pick<CollectionsAccess, "canConfirm" | "isOwner">,
): boolean {
  return who.canConfirm && (who.isOwner || !candidate.selfRecorded);
}

export interface CreditsAccess {
  /** `credits-paste` and `credit-ignore` (confirm_collections, 07 §4.5). */
  canPaste: boolean;
  canIgnore: boolean;
  /** `credit-show-raw` — owner only (07 §4.10; the server returns raw: null otherwise). */
  canShowRaw: boolean;
  /** The Unrecognised messages section and its share action — owner only. */
  canSeeUnrecognised: boolean;
}

/** The M2 rows of the §4.2 access table, from `collectionsAccess()`. */
export function creditsAccess(who: Pick<CollectionsAccess, "canConfirm" | "isOwner">): CreditsAccess {
  return {
    canPaste: who.canConfirm,
    canIgnore: who.canConfirm,
    canShowRaw: who.isOwner,
    canSeeUnrecognised: who.isOwner,
  };
}

export type HealthTone = "success" | "neutral" | "warning" | "danger";

/** 07's server-computed `DeviceHealth` → chip tone (never recomputed here). */
export function deviceHealthTone(h: DeviceHealth): HealthTone {
  switch (h) {
    case "ok":
      return "success";
    case "heartbeat_late":
      return "warning";
    case "silent":
    case "listener_off":
      return "danger";
    case "never_seen":
    case "revoked":
    default:
      return "neutral";
  }
}

export const HEALTH_TONE_CLASS: Readonly<Record<HealthTone, string>> = Object.freeze({
  success: "bg-success-light text-success",
  neutral: "bg-gray-100 text-text-secondary",
  warning: "bg-orange-100 text-orange-700",
  danger: "bg-danger-light text-danger",
});

/** Live devices first (newest first, as the server sends), then the ones
 *  revoked in the last 30 days (shown greyed under `recentlyUnlinked`). */
export function splitDevices<T extends { revokedAt: string | null }>(devices: readonly T[]): { live: T[]; revoked: T[] } {
  const live: T[] = [];
  const revoked: T[] = [];
  for (const d of devices) (d.revokedAt ? revoked : live).push(d);
  return { live, revoked };
}

/** NEW credits a paste created (the `credits.done.pasted` {n}): accepted AND
 *  with a creditId. An unknown-format piece is accepted but makes no credit. */
export function pastedCount(results: ReadonlyArray<{ status: string; creditId?: string | null }>): number {
  return results.filter((r) => r.status === "accepted" && !!r.creditId).length;
}

type PasteDoneCopy = {
  pasted: string;
  pastedOne?: string;
  pastedTwo?: string;
  pastedFew?: string;
  alreadyAdded: string;
  notRecognised: string;
  notCredit: string;
};

/** The toast after a paste (same rule as mobile's `pasteOutcome`): the count of
 *  new credits with the 1 / 2 / 3–10 forms (`done.pasted{One,Two,Few}`, else the
 *  base key), or why nothing new was added. */
export function pasteNotice(
  results: ReadonlyArray<{ status: string; creditId?: string | null }>,
  done: PasteDoneCopy,
): string {
  const n = pastedCount(results);
  if (n > 0) {
    const form = n === 1 ? done.pastedOne : n === 2 ? done.pastedTwo : n <= 10 ? done.pastedFew : undefined;
    return (form ?? done.pasted).replace("{n}", String(n));
  }
  if (results.some((r) => r.status === "duplicate")) return done.alreadyAdded;
  if (results.some((r) => r.status === "accepted")) return done.notRecognised;
  return done.notCredit;
}
