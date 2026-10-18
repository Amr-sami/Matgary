import type { ApiClient } from "../http";
import type { CollectionsFeatures } from "./me";
import type { IngestConfigBlock } from "./collection-credits";

/**
 * Digital collections (InstaPay + mobile wallets), L1 — the routes of
 * apps/web/app/api/collections/** (doc 15 spec 05, 03 §B.4 / §B.17).
 *
 * The unions mirror packages/domain/src/collections/types.ts (03 §B.1); this
 * package has no dependency on the domain package, so they are restated
 * here, verbatim.
 *
 * Decisions (confirm / reject / reopen) REQUIRE an Idempotency-Key: mint one
 * when the sheet / dialog opens and reuse it for every retry inside it
 * (03 §C.8 rule 12). A replay answers the original 200; the same key on
 * another collection answers 409 IDEMPOTENCY_MISMATCH.
 */

export type CollectionRail = "instapay" | "wallet";
export type CollectionProvider =
  | "nbe"
  | "cib"
  | "qnb"
  | "banque_misr"
  | "bdc"
  | "aaib"
  | "alexbank"
  | "hsbc"
  | "faisal"
  | "adib"
  | "other_bank"
  | "vodafone_cash"
  | "etisalat_money"
  | "orange_cash"
  | "we_pay"
  | "nbe_phone_cash"
  | "bm_wallet"
  | "other_wallet";
export type DigitalMethod = "instapay" | "wallet";
export type CollectionStatus = "pending" | "confirmed" | "auto_confirmed" | "rejected" | "void";
export type SaleCollectionStatus = "pending" | "confirmed" | "rejected";
export type CollectionSourceType = "sale" | "settlement";
export type RejectReason = "not_received" | "wrong_amount" | "wrong_account" | "duplicate" | "other";
export type RejectOutcome = "debt" | "loss";
export type CollectionFlag =
  | "account_inactive"
  | "account_missing"
  | "parts_clamped"
  | "total_changed"
  | "returned"
  | "offline_rung"
  | "via_provider";
export type CollectionEventKind =
  | "created"
  | "matched"
  | "auto_confirmed"
  | "confirmed"
  | "rejected"
  | "reopened"
  | "voided"
  | "amount_changed"
  | "account_changed"
  | "evidence_attached"
  | "stale_alerted"
  | "note";
export type LimitWarning = "day_80" | "month_80" | "new_wallet_day_80" | "balance_90";

// ---- Accounts ---------------------------------------------------------------

/** apps/web/lib/repo/collection-accounts.ts — CollectionAccountDTO. */
export interface CollectionAccountDTO {
  id: string;
  /** null = every branch of the shop. */
  branchId: string | null;
  rail: CollectionRail;
  provider: CollectionProvider;
  label: string;
  holderName: string | null;
  ipaHandle: string | null;
  ipaLink: string | null;
  accountLast4: string | null;
  isPrepaidCard: boolean;
  /** Every member: the cashier shows it to the customer. */
  walletMsisdn: string | null;
  /** Full value only with manage_collection_accounts; else null. */
  iban: string | null;
  ibanLast4: string | null;
  /** ASCII "***1234" | "***@instapay" | "***" (06 accountMask). */
  mask: string;
  walletOpenedOn: string | null;
  isDefaultForMobile: boolean;
  isPosDefault: boolean;
  autoConfirmEnabled: boolean;
  reviewThreshold: number;
  balanceCheckEnabled: boolean;
  /** manage only; else null. */
  balanceBaseline: number | null;
  balanceBaselineAt: string | null;
  balanceChainBrokenAt: string | null;
  sortOrder: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionAccountsResponse {
  data: CollectionAccountDTO[];
  branchId: string;
}

/** POST body (05 §4.14). `null` clears a field; omit to leave it. */
export interface AccountCreateBody {
  rail: CollectionRail;
  provider: CollectionProvider;
  label: string;
  holderName?: string | null;
  /** Owner: a branch, or null for every branch. Staff: their branch only. */
  branchId?: string | null;
  ipaLink?: string | null;
  ipaHandle?: string | null;
  accountLast4?: string | null;
  isPrepaidCard?: boolean | null;
  iban?: string | null;
  walletMsisdn?: string | null;
  walletOpenedOn?: string | null;
  isDefaultForMobile?: boolean | null;
  isPosDefault?: boolean | null;
  autoConfirmEnabled?: boolean | null;
  reviewThreshold?: number | string | null;
  balanceCheckEnabled?: boolean | null;
  sortOrder?: number | null;
}

/** PATCH body: every create field except rail and provider. */
export type AccountPatchBody = Partial<Omit<AccountCreateBody, "rail" | "provider">>;

export interface ListAccountsParams {
  /** `all` only for manage_collection_accounts (else read as `branch`). */
  scope?: "branch" | "all";
  includeArchived?: boolean;
}

/** GET /api/collections/accounts — active accounts of the active branch
 *  (branch rows + every-branch rows). */
export const listAccounts = (c: ApiClient, params: ListAccountsParams = {}) =>
  c.request<CollectionAccountsResponse>("/api/collections/accounts", {
    query: {
      scope: params.scope,
      includeArchived: params.includeArchived ? "1" : undefined,
    },
  });

/** POST /api/collections/accounts → 201 CollectionAccountDTO. */
export const createAccount = (c: ApiClient, body: AccountCreateBody, idempotencyKey?: string) =>
  c.request<CollectionAccountDTO>("/api/collections/accounts", {
    method: "POST",
    body,
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
  });

export const updateAccount = (c: ApiClient, id: string, body: AccountPatchBody) =>
  c.request<CollectionAccountDTO>(`/api/collections/accounts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });

/** DELETE = archive; pending collections keep pointing at it. */
export const archiveAccount = (c: ApiClient, id: string) =>
  c.request<{ archived: true; pendingCollections: number }>(
    `/api/collections/accounts/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );

// ---- Collections ------------------------------------------------------------

/** Defined by 05, filled by 07 from M2; always null in M1. */
export interface CreditSummary {
  id: string;
  amount: number;
  occurredAt: string;
  channels: string[];
  templateId: string;
  payerNameMasked: string | null;
  operatorReference: string | null;
}

/** 03 §B.17 CollectionDTO. */
export interface CollectionDTO {
  id: string;
  status: CollectionStatus;
  sourceType: CollectionSourceType;
  method: DigitalMethod;
  amount: number;
  partNo: number;
  partsCount: number;
  invoiceId: string | null;
  anchorSaleId: string | null;
  branchId: string;
  account: { id: string; label: string; provider: CollectionProvider; rail: CollectionRail; mask: string } | null;
  payerPhoneLast4: string | null;
  payerReference: string | null;
  /** ISO — when the sale was rung (offline: the client's customDate). */
  rungAt: string;
  recordedBy: { id: string; name: string | null } | null;
  decidedBy: { id: string; name: string | null } | null;
  decidedAt: string | null;
  rejectReason: RejectReason | null;
  rejectOutcome: RejectOutcome | null;
  flags: CollectionFlag[];
  isStale: boolean;
  matchedCredit: CreditSummary | null;
  customerPhone: string | null;
}

export interface CollectionEventDTO {
  kind: CollectionEventKind;
  fromStatus: CollectionStatus | null;
  toStatus: CollectionStatus | null;
  actor: { id: string; name: string | null } | null;
  createdAt: string;
  /** Line snapshots (`details.lines`) are stripped for non-owners. */
  details: Record<string, unknown>;
}

export interface CollectionDetailDTO extends CollectionDTO {
  events: CollectionEventDTO[];
}

export interface CollectionsPage {
  data: CollectionDTO[];
  nextCursor: string | null;
  /** Same branch scope, ignoring status / cursor — the nav badge. */
  counts: { pending: number; stale: number };
}

export interface ListCollectionsParams {
  /** One status or a comma list, e.g. "confirmed,auto_confirmed". */
  status?: CollectionStatus | string;
  accountId?: string;
  sourceType?: CollectionSourceType;
  /** A branch id, or "all" (owner only). */
  branchId?: string | "all";
  /** ISO, on rungAt. */
  from?: string;
  to?: string;
  stale?: boolean;
  invoiceId?: string;
  order?: "asc" | "desc";
  cursor?: string | null;
  /** 1..100, default 50. */
  limit?: number;
}

/** GET /api/collections. A cashier without view_collections gets only the
 *  rows they recorded (never a 403). */
export const listCollections = (c: ApiClient, params: ListCollectionsParams = {}) =>
  c.request<CollectionsPage>("/api/collections", {
    query: {
      status: params.status,
      accountId: params.accountId,
      sourceType: params.sourceType,
      branchId: params.branchId,
      from: params.from,
      to: params.to,
      stale: params.stale ? "1" : undefined,
      invoiceId: params.invoiceId,
      order: params.order,
      cursor: params.cursor ?? undefined,
      limit: params.limit,
    },
  });

export const getCollection = (c: ApiClient, id: string) =>
  c.request<CollectionDetailDTO>(`/api/collections/${encodeURIComponent(id)}`);

export interface UpdateCollectionBody {
  collectionAccountId?: string;
  payerPhoneLast4?: string | null;
  payerReference?: string | null;
}

/** PATCH /api/collections/[id] — while pending; the recorder or a confirmer. */
export const updateCollection = (c: ApiClient, id: string, body: UpdateCollectionBody) =>
  c.request<CollectionDTO>(`/api/collections/${encodeURIComponent(id)}`, { method: "PATCH", body });

export interface ConfirmCollectionBody {
  note?: string;
}

export const confirmCollection = (
  c: ApiClient,
  id: string,
  body: ConfirmCollectionBody,
  idempotencyKey: string,
) =>
  c.request<CollectionDTO>(`/api/collections/${encodeURIComponent(id)}/confirm`, {
    method: "POST",
    body,
    headers: { "Idempotency-Key": idempotencyKey },
  });

export interface RejectCollectionBody {
  reason: RejectReason;
  /** Default: debt when the sale has (or this body gives) a customer phone, else loss. */
  outcome?: RejectOutcome;
  customerPhone?: string;
  note?: string;
}

export const rejectCollection = (
  c: ApiClient,
  id: string,
  body: RejectCollectionBody,
  idempotencyKey: string,
) =>
  c.request<CollectionDTO>(`/api/collections/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    body,
    headers: { "Idempotency-Key": idempotencyKey },
  });

export interface ReopenCollectionBody {
  note?: string;
}

/** Owner only, ≤ 7 days after the decision. */
export const reopenCollection = (
  c: ApiClient,
  id: string,
  body: ReopenCollectionBody,
  idempotencyKey: string,
) =>
  c.request<CollectionDTO>(`/api/collections/${encodeURIComponent(id)}/reopen`, {
    method: "POST",
    body,
    headers: { "Idempotency-Key": idempotencyKey },
  });

// ---- Summary / settings / config -------------------------------------------

export interface SummaryBucket {
  count: number;
  amount: number;
}

export interface CollectionsSummaryAccount {
  /** null = the "no account" row. */
  accountId: string | null;
  label: string | null;
  provider: CollectionProvider | null;
  rail: CollectionRail | null;
  confirmed: SummaryBucket;
  autoConfirmed: SummaryBucket;
  pending: SummaryBucket;
  rejectedDebt: SummaryBucket;
  rejectedLoss: SummaryBucket;
  /** {0,0} until M2. */
  unmatchedCredits: SummaryBucket;
  limitWarnings: LimitWarning[];
}

export interface CollectionsSummary {
  /** YYYY-MM-DD, the shop's time zone. */
  date: string;
  branchId: string | null;
  accounts: CollectionsSummaryAccount[];
  totals: {
    confirmed: SummaryBucket;
    autoConfirmed: SummaryBucket;
    pending: SummaryBucket;
    rejectedDebt: SummaryBucket;
    rejectedLoss: SummaryBucket;
    unmatchedCredits: SummaryBucket;
    /** Cash taken at the counter on split invoices. */
    cashRemainder: number;
  };
}

/** GET /api/collections/summary — view_collections. `date` omitted = today. */
export const getSummary = (c: ApiClient, params: { date?: string; branchId?: string | "all" } = {}) =>
  c.request<CollectionsSummary>("/api/collections/summary", {
    query: { date: params.date, branchId: params.branchId },
  });

export interface CollectionSettings {
  branchId: string;
  collectionsEnabled: boolean;
  collectionsRequireAccount: boolean;
  /** 15..1440. */
  collectionsStaleAfterMinutes: number;
  collectionsAutoConfirmEnabled: boolean;
  collectionsStorePayerNames: boolean;
}

export type CollectionSettingsPatch = Partial<Omit<CollectionSettings, "branchId">>;

export const getSettings = (c: ApiClient, branchId?: string) =>
  c.request<CollectionSettings>("/api/collections/settings", { query: { branchId } });

/** PATCH — manage_collection_accounts. */
export const updateSettings = (c: ApiClient, patch: CollectionSettingsPatch, branchId?: string) =>
  c.request<CollectionSettings>("/api/collections/settings", {
    method: "PATCH",
    body: patch,
    query: { branchId },
  });

/** 03 §B.17 CollectionsConfigDTO; `ingest` (07 §4.6) is null while
 *  features.collectionsIngest is off. */
export interface CollectionsConfig {
  features: CollectionsFeatures;
  branchId: string;
  requireAccount: boolean;
  staleAfterMinutes: number;
  limits: { maxParts: number; reopenDays: number; noteMaxLength: number };
  ingest: IngestConfigBlock | null;
}

/** GET /api/collections/config — answers 200 (flags all false) even when the
 *  shop is not admitted. */
export const getConfig = (c: ApiClient) => c.request<CollectionsConfig>("/api/collections/config");
