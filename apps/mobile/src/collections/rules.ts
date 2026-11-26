/**
 * Digital collections — who may do what on the phone, and the small pure
 * rules the inbox, the detail screen and the badges share (doc 15 spec 08
 * §4.7–§4.9, §4.12; 03 §B.5, §E.5, §E.6).
 *
 * TYPE-ONLY imports: `node --test --experimental-strip-types` loads it.
 *
 * The server is the authority on every gate; these rules only decide what
 * the UI offers, so a button never leads to a 403 it could have predicted.
 */
import type { MeResponse, collectionCredits, collections, me as meApi, sales } from "@matgary/api-client";

type CollectionStatus = collections.CollectionStatus;
type CollectionSourceType = collections.CollectionSourceType;
type RejectOutcome = collections.RejectOutcome;
type RejectReason = collections.RejectReason;
type SaleCollectionStatus = collections.SaleCollectionStatus;
type CollectionsFeatures = meApi.CollectionsFeatures;
type IgnoreReason = collectionCredits.IgnoreReason;
type CollectionCandidate = collectionCredits.CollectionCandidate;
type CreditDTO = collectionCredits.CreditDTO;
type PasteResult = collectionCredits.PasteResult;

export interface CollectionAccess {
  isOwner: boolean;
  userId: string | null;
  /** Inbox, totals, any collection's detail: owner or `view_collections`. */
  canView: boolean;
  /**
   * Confirm / reject: owner, or `confirm_collections` TOGETHER with
   * `view_collections` — without view the inbox is unreachable and
   * GET collections/[id] answers 403 (03 §B.5, R8).
   */
  canConfirm: boolean;
  /** Accounts, collections settings: owner or `manage_collection_accounts`. */
  canManage: boolean;
  /** Ring sales (and PATCH the payer hints of an own pending collection). */
  canRecord: boolean;
}

/** `me` is the /api/v1/me answer (permissions are EFFECTIVE, owner-expanded). */
export function collectionAccess(me: Pick<MeResponse, "isOwner" | "permissions" | "user"> | null | undefined): CollectionAccess {
  const isOwner = Boolean(me?.isOwner);
  const perms = new Set(me?.permissions ?? []);
  const canView = isOwner || perms.has("view_collections");
  return {
    isOwner,
    userId: me?.user?.id ?? null,
    canView,
    canConfirm: isOwner || (perms.has("confirm_collections") && perms.has("view_collections")),
    canManage: isOwner || perms.has("manage_collection_accounts"),
    canRecord: isOwner || perms.has("record_sales"),
  };
}

type Decidable = { status: CollectionStatus; recordedBy: { id: string } | null };

/**
 * Whether the viewer may confirm / reject `c` now. `self` is the four-eyes
 * rule (03 §E.6): staff never decide a collection they recorded; owners are
 * exempt (single-owner shops). The buttons render disabled for `self`.
 */
export function canDecide(access: CollectionAccess, c: Decidable): "ok" | "not_pending" | "no_permission" | "self" {
  if (c.status !== "pending") return "not_pending";
  if (!access.canConfirm) return "no_permission";
  if (!access.isOwner && access.userId != null && c.recordedBy?.id === access.userId) return "self";
  return "ok";
}

/** Mirrors MATCH_CONSTANTS.REOPEN_DAYS (03 §C.8); switch to the domain constant when 06 part B lands. */
export const REOPEN_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

/** Owner only, a decided collection, within 7 days of the decision (03 §B.4). */
export function canReopen(
  access: Pick<CollectionAccess, "isOwner">,
  c: { status: CollectionStatus; decidedAt: string | null },
  now: Date | number = Date.now(),
): boolean {
  if (!access.isOwner) return false;
  if (c.status !== "confirmed" && c.status !== "auto_confirmed" && c.status !== "rejected") return false;
  if (!c.decidedAt) return false;
  const at = new Date(c.decidedAt).getTime();
  if (Number.isNaN(at)) return false;
  const nowMs = typeof now === "number" ? now : now.getTime();
  return nowMs - at <= REOPEN_WINDOW_DAYS * DAY_MS;
}

/** The last moment `c` can be reopened, or null (not decided). */
export function reopenDeadline(c: { decidedAt: string | null }): Date | null {
  if (!c.decidedAt) return null;
  const at = new Date(c.decidedAt).getTime();
  return Number.isNaN(at) ? null : new Date(at + REOPEN_WINDOW_DAYS * DAY_MS);
}

type RejectTarget = { sourceType: CollectionSourceType; customerPhone: string | null };

/**
 * Q4: a settlement rejection is always `debt` (the payment is voided and the
 * debt restored); otherwise `debt` when the sale knows the customer's phone,
 * else `loss` (noted on the cashier).
 */
export function defaultRejectOutcome(c: RejectTarget): RejectOutcome {
  if (c.sourceType === "settlement") return "debt";
  return c.customerPhone ? "debt" : "loss";
}

/** Debt needs a customer to owe it: ask for a phone when the sale has none. */
export function rejectNeedsPhone(c: RejectTarget, outcome: RejectOutcome): boolean {
  return outcome === "debt" && c.sourceType === "sale" && !c.customerPhone;
}

export const REJECT_REASONS = [
  "not_received",
  "wrong_amount",
  "wrong_account",
  "duplicate",
  "other",
] as const satisfies readonly RejectReason[];

/** 03 §B.1 IgnoreReason (credits, M2). */
export const IGNORE_REASONS = ["personal", "not_a_sale", "duplicate", "other"] as const satisfies readonly IgnoreReason[];

// ─── inbox ───────────────────────────────────────────────────────────────────

export type InboxTab = "pending" | "credits" | "confirmed" | "rejected" | "totals";

/** Tabs in order; `credits` only with features.collectionsIngest (M2). */
export function inboxTabs(features: Pick<CollectionsFeatures, "collectionsIngest"> | null | undefined, _access?: CollectionAccess): InboxTab[] {
  return features?.collectionsIngest
    ? ["pending", "credits", "confirmed", "rejected", "totals"]
    : ["pending", "confirmed", "rejected", "totals"];
}

type Param = string | string[] | undefined;
const first = (v: Param): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * The web links of 03 §B.6 (`?status=pending`, `?status=pending&stale=1`,
 * `?tab=credits`, `?tab=totals`) — a push `route` carries them unchanged, so
 * the phone opens the same tab. Unknown values fall back to Pending; Credits
 * without ingest too. Extra params (`account`, `warning`) are ignored.
 */
export function parseInboxParams(
  params: Record<string, Param> | null | undefined,
  features?: Pick<CollectionsFeatures, "collectionsIngest"> | null,
): { tab: InboxTab; staleOnly: boolean } {
  const p = params ?? {};
  const tabs = inboxTabs(features ?? null);
  const staleOnly = ["1", "true"].includes(first(p.stale) ?? "");
  const tabParam = first(p.tab);
  const statusParam = first(p.status);
  let tab: InboxTab = "pending";
  if (tabParam && (tabs as string[]).includes(tabParam)) tab = tabParam as InboxTab;
  else if (statusParam === "confirmed" || statusParam === "auto_confirmed") tab = "confirmed";
  else if (statusParam === "rejected") tab = "rejected";
  if (staleOnly) tab = "pending";
  return { tab, staleOnly: staleOnly && tab === "pending" };
}

/** The list-route status filter per tab (ARCH CR 3: a comma list). */
export function statusFilterFor(tab: InboxTab): string | null {
  switch (tab) {
    case "pending":
      return "pending";
    case "confirmed":
      return "confirmed,auto_confirmed";
    case "rejected":
      return "rejected";
    default:
      return null;
  }
}

// ─── badges ──────────────────────────────────────────────────────────────────

/**
 * The invoice-level status from its lines: the server writes
 * `sales.collection_status` on EVERY line in the same transaction (03
 * §B.2.4), so the first non-null value is the invoice's. `groupInvoices`
 * now aggregates the same value as `Invoice.collectionStatus`; this helper
 * stays for callers that hold bare lines.
 */
export function invoiceCollectionStatus(
  lines: readonly { collectionStatus?: SaleCollectionStatus | null }[],
): SaleCollectionStatus | null {
  for (const l of lines) if (l.collectionStatus) return l.collectionStatus;
  return null;
}

/**
 * The dashboard row's one badge, by priority (08 §4.9): returned → a
 * rejected transfer → awaiting confirmation → an unpaid deferred sale → the
 * method label.
 */
export function saleBadgeKind(s: {
  isReturned?: boolean;
  paymentMethod?: sales.PaymentMethod | null;
  isPaid?: boolean;
  collectionStatus?: SaleCollectionStatus | null;
}): "returned" | "rejected" | "pending" | "unpaid" | "method" | null {
  if (s.isReturned) return "returned";
  if (s.collectionStatus === "rejected") return "rejected";
  if (s.collectionStatus === "pending") return "pending";
  if (s.paymentMethod === "deferred" && !s.isPaid) return "unpaid";
  return s.paymentMethod ? "method" : null;
}

// ─── errors ──────────────────────────────────────────────────────────────────

/** Codes with a sentence under app.collections.errors.* (05's subtree). */
export const KNOWN_COLLECTION_ERRORS = [
  "COLLECTIONS_DISABLED",
  "COLLECTION_NOT_FOUND",
  "COLLECTION_NOT_PENDING",
  "SELF_CONFIRM_FORBIDDEN",
  "REJECT_OUTCOME_REQUIRES_PHONE",
  "REOPEN_WINDOW_CLOSED",
  "REOPEN_BLOCKED_SETTLED",
  "COLLECTION_ACCOUNT_NOT_FOUND",
  "COLLECTION_NOT_REOPENABLE",
  "CREDIT_NOT_FOUND",
  "CREDIT_ALREADY_MATCHED",
  "CREDIT_NOT_MATCHABLE",
  "INGEST_DISABLED",
  "INGEST_PAYLOAD_TOO_LARGE",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_MISMATCH",
  "INVALID_PHONE",
  "INVALID_REQUEST",
  "RATE_LIMITED",
  "FORBIDDEN_BRANCH",
  "NOT_FOUND",
] as const;

/** The i18n key for a server error code, or null (the caller falls back to errorText). */
export function collectionErrorKey(code: string | null | undefined): string | null {
  return code && (KNOWN_COLLECTION_ERRORS as readonly string[]).includes(code) ? `app.collections.errors.${code}` : null;
}

// ─── credits (M2, spec 08 §4.11) ─────────────────────────────────────────────

/** The credits tab lists what still needs a person (03 §B.4 comma list). */
export const OPEN_CREDIT_STATES = "unmatched,held";

export interface CreditsAccess {
  /** The tab itself: features.collectionsIngest + view (03 §B.4 GET credits = view_collections). */
  canList: boolean;
  /** Paste, match, ignore: `confirm_collections` (with view), or the owner. */
  canPaste: boolean;
  canIgnore: boolean;
  /** The Unrecognised section and its "send to TheStoro": owner only (03 §B.4, ARCH CR 8). */
  canSeeUnrecognised: boolean;
}

export function creditsAccess(
  features: Pick<CollectionsFeatures, "collections" | "collectionsIngest"> | null | undefined,
  access: Pick<CollectionAccess, "isOwner" | "canView" | "canConfirm">,
): CreditsAccess {
  const on = Boolean(features?.collections && features?.collectionsIngest);
  const canList = on && access.canView;
  return {
    canList,
    canPaste: canList && access.canConfirm,
    canIgnore: canList && access.canConfirm,
    canSeeUnrecognised: canList && access.isOwner,
  };
}

/**
 * One-tap match of a credit to a candidate collection: `confirm_collections`
 * + four-eyes on the COLLECTION (staff never match a sale they recorded;
 * owner exempt, 03 §E.6). The server answers SELF_CONFIRM_FORBIDDEN anyway;
 * the button renders disabled for `self` so no request is sent.
 */
export function canMatchCandidate(
  access: Pick<CollectionAccess, "isOwner" | "canConfirm" | "userId">,
  credit: Pick<CreditDTO, "state">,
  candidate: Pick<CollectionCandidate, "status" | "selfRecorded" | "recordedBy">,
): "ok" | "not_open" | "not_pending" | "no_permission" | "self" {
  if (credit.state !== "unmatched" && credit.state !== "held") return "not_open";
  if (candidate.status !== "pending") return "not_pending";
  if (!access.canConfirm) return "no_permission";
  if (!access.isOwner) {
    if (candidate.selfRecorded) return "self";
    if (access.userId != null && candidate.recordedBy?.id === access.userId) return "self";
  }
  return "ok";
}

/** §C.8 rule 11: the match button warns when the amount or the account differs (piasters, never floats). */
export function candidateWarnings(
  credit: Pick<CreditDTO, "amount" | "account">,
  candidate: Pick<CollectionCandidate, "amount" | "accountId">,
): { amountDiffers: boolean; accountDiffers: boolean } {
  return {
    amountDiffers: Math.round(credit.amount * 100) !== Math.round(candidate.amount * 100),
    accountDiffers: Boolean(credit.account && candidate.accountId && candidate.accountId !== credit.account.id),
  };
}

/** The payer as the credit carries it: full name (opt-in), masked name, or "•••• 1234". */
export function creditPayerText(c: Pick<CreditDTO, "payerName" | "payerNameMasked" | "payerPhoneLast4">): string | null {
  if (c.payerName) return c.payerName;
  if (c.payerNameMasked) return c.payerNameMasked;
  if (c.payerPhoneLast4) return `•••• ${c.payerPhoneLast4}`;
  return null;
}

export type PasteNotice = "added" | "already" | "unrecognised" | "not_credit";

/**
 * What a paste did, from `POST collections/credits/paste` `results[]` (07
 * §4.13): `added` counts the NEW credits (accepted WITH a creditId). An
 * unknown-format message is `accepted` too but creates no credit — it goes
 * to the owner's Unrecognised list — so it is counted apart (the web's
 * `pastedCount` counts it as added). The notice is the best news first.
 */
export function pasteOutcome(results: readonly Pick<PasteResult, "status" | "reason" | "creditId">[]): {
  added: number;
  duplicates: number;
  unrecognised: number;
  dropped: number;
  notice: PasteNotice;
} {
  let added = 0;
  let duplicates = 0;
  let unrecognised = 0;
  let dropped = 0;
  for (const r of results) {
    if (r.status === "accepted" && r.creditId) added++;
    else if (r.status === "accepted") unrecognised++;
    else if (r.status === "duplicate") duplicates++;
    else dropped++;
  }
  const notice: PasteNotice =
    added > 0 ? "added" : duplicates > 0 ? "already" : unrecognised > 0 ? "unrecognised" : "not_credit";
  return { added, duplicates, unrecognised, dropped, notice };
}

/** 07 §4.5: the paste `text` is 1..10,000 characters (≤ 20 pieces). */
export const PASTE_MAX_CHARS = 10_000;
