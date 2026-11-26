// Digital collections L2 — the credits inbox API (spec 07 §4.5, §4.6, §4.10,
// §4.13): list / detail / match / ignore / paste, the owner-only
// "Unrecognised messages" list + share, and `loadCreditSummaries` for 05's
// CollectionDTO.matchedCredit.
//
// Lock rule (07 §4.7 step 5): the per-account advisory locks (ascending)
// BEFORE any FOR UPDATE on collection_credits / collections; then 05's house
// order (an invoice's parts before its sales lines).

import { sql, type SQL } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import type { TenantTx } from "@/lib/collections/flags";
import { DomainError } from "@/lib/errors";
import { isUniqueViolation } from "@/lib/api/idempotency";
import { bustInsightsCache } from "@/lib/repo/insights";
import {
  assertNotSelfDecision,
  insertCollectionEvent,
  loadCollectionForUpdate,
  lockInvoiceCollections,
  reconcileInvoiceCollectionStatus,
  type CreditSummary,
} from "@/lib/repo/collections";
import {
  flushMatchEffects,
  loadAccountForEval,
  loadCreditForUpdate,
  lockAccounts,
  moveBaseline,
  newEffects,
} from "@/lib/repo/collection-matching";
import { ingestOne, type IngestMessage } from "@/lib/repo/collection-ingest";
import { decodeTitleSubtitle, decryptRawText } from "@/lib/collections/raw-text";
import { rankCandidates } from "@matgary/domain/collections/match";
import { accountMask, toPiasters } from "@matgary/domain/collections/normalize";
import { templateById } from "@matgary/domain/collections/templates/index";
import type {
  CollectionProvider,
  CollectionRail,
  CollectionStatus,
  CreditDirection,
  CreditState,
  DigitalMethod,
  HoldReason,
  IgnoreReason,
  IngestChannel,
  ParseStatus,
  SenderKind,
} from "@matgary/domain/collections/types";

export const CREDITS_PAGE_MAX = 100;
export const CREDITS_PAGE_DEFAULT = 50;
export const PASTE_MAX_PIECES = 20;
export const SHARE_RETENTION_DAYS = 90;

// ─────────────────────────────────────────────────────────────────────────────
// Wire shapes (07 §4.6, 03 §B.17)
// ─────────────────────────────────────────────────────────────────────────────

export interface AccountRef {
  id: string;
  label: string;
  provider: CollectionProvider;
  rail: CollectionRail;
  mask: string;
}

export interface CollectionCandidate {
  id: string;
  amount: number;
  rungAt: string;
  status: CollectionStatus;
  method: DigitalMethod;
  accountId: string | null;
  invoiceId: string | null;
  recordedBy: { id: string; name: string | null } | null;
  payerPhoneLast4: string | null;
  payerReference: string | null;
  strongSignal: boolean;
  deltaMinutes: number;
  /** Four-eyes hint for the UI: the viewer recorded it. */
  selfRecorded: boolean;
}

export interface CreditDTO extends CreditSummary {
  state: CreditState;
  direction: CreditDirection;
  holdReason: HoldReason | null;
  account: AccountRef | null;
  branchId: string | null;
  templateStatus: "published_sample" | "pilot_verified" | "fallback";
  payerName: string | null;
  balanceAfter: number | null;
  receivingHint: string | null;
  senderKind: SenderKind;
  deviceReceivedAt: string;
  device: { id: string; label: string } | null;
  suggestedCollection: CollectionCandidate | null;
  matchedCollection: CollectionCandidate | null;
  ignoredReason: IgnoreReason | null;
  decidedBy: { id: string; name: string | null } | null;
  decidedAt: string | null;
  seenCount: number;
  createdAt: string;
}

export interface CreditDetailDTO extends CreditDTO {
  candidates: CollectionCandidate[];
  raw: { title: string | null; subtitle: string | null; body: string } | null;
}

export interface PasteResult {
  index: number;
  status: "accepted" | "duplicate" | "dropped";
  reason?: ParseStatus | "channel_not_allowed";
  creditId?: string;
  state?: CreditState;
  holdReason?: HoldReason | null;
  suggestedCollectionId?: string | null;
}

export interface UnrecognisedDTO {
  id: string;
  channel: IngestChannel;
  sourceApp: string | null;
  sender: string | null;
  senderKind: SenderKind;
  title: string | null;
  subtitle: string | null;
  body: string;
  parseStatus: "unknown_format" | "fallback";
  templateId: string | null;
  receivedAt: string;
  device: { id: string; label: string } | null;
  sharedAt: string | null;
  expiresAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function toIso(v: string | Date | null | undefined): string | null {
  if (v == null) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function egp(v: string | null | undefined): number {
  return v == null ? 0 : toPiasters(v) / 100;
}

function idList(ids: readonly string[]): SQL {
  return sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
}

function encodeCursor(key: string, id: string): string {
  return Buffer.from(`${key}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string): { at: string; id: string } {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const i = text.lastIndexOf("|");
  const at = i > 0 ? text.slice(0, i) : "";
  const id = i > 0 ? text.slice(i + 1) : "";
  if (!at || Number.isNaN(Date.parse(at)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new DomainError("INVALID_CURSOR", 400);
  }
  return { at, id };
}

export interface CreditAccess {
  /** null = every branch (owner). */
  accessibleBranchIds: string[] | null;
  userId: string;
}

function reachable(branchId: string | null, access: CreditAccess): boolean {
  return branchId === null || access.accessibleBranchIds === null || access.accessibleBranchIds.includes(branchId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows → DTOs
// ─────────────────────────────────────────────────────────────────────────────

interface CreditDtoRow {
  id: string;
  amount: string;
  occurred_at: string;
  channels: string[];
  template_id: string;
  state: string;
  sender: string | null;
  operator_reference: string | null;
  payer_phone_last4: string | null;
  payer_name_masked: string | null;
  payer_name: string | null;
  direction: string;
  hold_reason: string | null;
  branch_id: string | null;
  balance_after: string | null;
  receiving_hint: string | null;
  sender_kind: string;
  device_received_at: string;
  ingest_device_id: string | null;
  device_label: string | null;
  suggested_collection_id: string | null;
  matched_collection_id: string | null;
  ignored_reason: string | null;
  decided_by_user_id: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  seen_count: number;
  created_at: string;
  created_key: string;
  occurred_key: string;
  collection_account_id: string | null;
  account_label: string | null;
  account_provider: string | null;
  account_rail: string | null;
  account_last4: string | null;
  wallet_msisdn: string | null;
  ipa_handle: string | null;
  is_prepaid_card: boolean | null;
  raw_message_id: string | null;
  is_test: boolean;
}

function creditDtoQuery(tenantId: string, where: SQL, tail: SQL = sql``): SQL {
  return sql`
    SELECT c.id, c.amount::text AS amount, c.occurred_at, c.channels, c.template_id, c.state, c.sender,
           c.operator_reference, c.payer_phone_last4, c.payer_name_masked, c.payer_name, c.direction,
           c.hold_reason, c.branch_id, c.balance_after::text AS balance_after, c.receiving_hint, c.sender_kind,
           c.device_received_at, c.ingest_device_id, d.label AS device_label, c.suggested_collection_id,
           c.matched_collection_id, c.ignored_reason, c.decided_by_user_id, u.name AS decided_by_name,
           c.decided_at, c.seen_count, c.created_at, to_json(c.created_at) #>> '{}' AS created_key,
           to_json(c.occurred_at) #>> '{}' AS occurred_key, c.collection_account_id,
           a.label AS account_label, a.provider AS account_provider, a.rail AS account_rail,
           a.account_last4, a.wallet_msisdn, a.ipa_handle, a.is_prepaid_card, c.raw_message_id, c.is_test
      FROM collection_credits c
      LEFT JOIN collection_accounts a ON a.tenant_id = c.tenant_id AND a.id = c.collection_account_id
      LEFT JOIN collection_ingest_devices d ON d.tenant_id = c.tenant_id AND d.id = c.ingest_device_id
      LEFT JOIN users u ON u.id = c.decided_by_user_id
     WHERE c.tenant_id = ${tenantId} AND ${where}
     ${tail}`;
}

interface CandidateRow {
  id: string;
  amount: string;
  rung_at: string;
  status: string;
  method: string;
  collection_account_id: string | null;
  invoice_id: string | null;
  recorded_by_user_id: string | null;
  recorded_by_name: string | null;
  payer_phone_last4: string | null;
  payer_reference: string | null;
  matched_credit_id: string | null;
  branch_id: string;
}

function candidateQuery(tenantId: string, where: SQL, tail: SQL = sql``): SQL {
  return sql`
    SELECT k.id, k.amount::text AS amount, to_json(k.rung_at) #>> '{}' AS rung_at, k.status, k.method,
           k.collection_account_id, k.invoice_id, k.recorded_by_user_id, ru.name AS recorded_by_name,
           k.payer_phone_last4, k.payer_reference, k.matched_credit_id, k.branch_id
      FROM collections k
      LEFT JOIN users ru ON ru.id = k.recorded_by_user_id
     WHERE k.tenant_id = ${tenantId} AND ${where}
     ${tail}`;
}

/** A collection as the credit's inbox row shows it (signals via 06's ranker). */
export function toCandidate(
  credit: { amount: string; occurredAt: string; accountId: string | null; operatorReference: string | null; payerPhoneLast4: string | null; templateId: string },
  k: CandidateRow,
  viewerUserId: string,
): CollectionCandidate {
  const template = templateById(credit.templateId);
  const ranked = rankCandidates(
    {
      accountId: credit.accountId,
      rail: template?.rail ?? null,
      amount: credit.amount,
      occurredAt: credit.occurredAt,
      operatorReference: credit.operatorReference,
      operatorReferenceFormat: template?.referenceFormat ?? "none",
      payerPhoneLast4: credit.payerPhoneLast4,
    },
    [
      {
        id: k.id,
        status: "pending", // signals only; the real status is reported below
        accountId: k.collection_account_id,
        method: k.method as DigitalMethod,
        amount: k.amount,
        rungAt: k.rung_at,
        payerReference: k.payer_reference,
        payerPhoneLast4: k.payer_phone_last4,
        matchedCreditId: k.matched_credit_id,
      },
    ],
  )[0];
  const deltaMinutes = Math.round((Date.parse(credit.occurredAt) - Date.parse(k.rung_at)) / 60_000);
  return {
    id: k.id,
    amount: egp(k.amount),
    rungAt: toIso(k.rung_at)!,
    status: k.status as CollectionStatus,
    method: k.method as DigitalMethod,
    accountId: k.collection_account_id,
    invoiceId: k.invoice_id,
    recordedBy: k.recorded_by_user_id ? { id: k.recorded_by_user_id, name: k.recorded_by_name } : null,
    payerPhoneLast4: k.payer_phone_last4,
    payerReference: k.payer_reference,
    strongSignal: !!ranked && ranked.signals.length > 0 && !ranked.conflict,
    deltaMinutes,
    selfRecorded: k.recorded_by_user_id !== null && k.recorded_by_user_id === viewerUserId,
  };
}

function summaryOf(r: CreditDtoRow): CreditSummary {
  return {
    id: r.id,
    amount: egp(r.amount),
    occurredAt: toIso(r.occurred_at)!,
    channels: r.channels ?? [],
    templateId: r.template_id,
    payerNameMasked: r.payer_name_masked,
    operatorReference: r.operator_reference,
    state: r.state,
    sender: r.sender,
    payerPhoneLast4: r.payer_phone_last4,
  };
}

export function toCreditDTO(r: CreditDtoRow, collections: Map<string, CandidateRow>, viewerUserId: string): CreditDTO {
  const credit = {
    amount: r.amount,
    occurredAt: toIso(r.occurred_at)!,
    accountId: r.collection_account_id,
    operatorReference: r.operator_reference,
    payerPhoneLast4: r.payer_phone_last4,
    templateId: r.template_id,
  };
  const cand = (id: string | null) => {
    const k = id ? collections.get(id) : undefined;
    return k ? toCandidate(credit, k, viewerUserId) : null;
  };
  const template = templateById(r.template_id);
  return {
    ...summaryOf(r),
    state: r.state as CreditState,
    direction: r.direction as CreditDirection,
    holdReason: (r.hold_reason as HoldReason | null) ?? null,
    account:
      r.collection_account_id && r.account_label != null
        ? {
            id: r.collection_account_id,
            label: r.account_label,
            provider: r.account_provider as CollectionProvider,
            rail: r.account_rail as CollectionRail,
            mask: accountMask({
              accountLast4: r.account_last4,
              walletMsisdn: r.wallet_msisdn,
              ipaHandle: r.ipa_handle,
              isPrepaidCard: r.is_prepaid_card,
            }),
          }
        : null,
    branchId: r.branch_id,
    templateStatus: template ? template.status : "fallback",
    payerName: r.payer_name,
    balanceAfter: r.balance_after == null ? null : egp(r.balance_after),
    receivingHint: r.receiving_hint,
    senderKind: r.sender_kind as SenderKind,
    deviceReceivedAt: toIso(r.device_received_at)!,
    device: r.ingest_device_id && r.device_label != null ? { id: r.ingest_device_id, label: r.device_label } : null,
    // Only a still-pending sale is a suggestion. A manual confirm/reject does not
    // clear other credits' suggested_collection_id (only the match path does,
    // above), and clearing it there would take credit locks inside the
    // collection-decision transaction — the reverse of the match path's order.
    // Filtering on read keeps the lock order and never offers a dead match (W1).
    suggestedCollection: (() => {
      const k = r.suggested_collection_id ? collections.get(r.suggested_collection_id) : undefined;
      return k && k.status === "pending" ? toCandidate(credit, k, viewerUserId) : null;
    })(),
    matchedCollection: cand(r.matched_collection_id),
    ignoredReason: (r.ignored_reason as IgnoreReason | null) ?? null,
    decidedBy: r.decided_by_user_id ? { id: r.decided_by_user_id, name: r.decided_by_name } : null,
    decidedAt: toIso(r.decided_at),
    seenCount: Number(r.seen_count ?? 1),
    createdAt: toIso(r.created_at)!,
  };
}

async function linkedCollections(tx: TenantTx, tenantId: string, rows: CreditDtoRow[]): Promise<Map<string, CandidateRow>> {
  const ids = [
    ...new Set(rows.flatMap((r) => [r.suggested_collection_id, r.matched_collection_id]).filter((x): x is string => !!x)),
  ];
  if (ids.length === 0) return new Map();
  const ks = (await tx.execute(candidateQuery(tenantId, sql`k.id IN (${idList(ids)})`))) as unknown as CandidateRow[];
  return new Map(ks.map((k) => [k.id, k]));
}

async function readCreditDto(tx: TenantTx, tenantId: string, id: string, viewerUserId: string): Promise<CreditDTO | null> {
  const rows = (await tx.execute(creditDtoQuery(tenantId, sql`c.id = ${id}`))) as unknown as CreditDtoRow[];
  if (!rows[0]) return null;
  return toCreditDTO(rows[0], await linkedCollections(tx, tenantId, rows), viewerUserId);
}

/** 05's CollectionDTO.matchedCredit (07 §4.3). */
export async function loadCreditSummaries(
  tx: TenantTx,
  tenantId: string,
  creditIds: readonly string[],
): Promise<Map<string, CreditSummary>> {
  const ids = [...new Set(creditIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = (await tx.execute(creditDtoQuery(tenantId, sql`c.id IN (${idList(ids)})`))) as unknown as CreditDtoRow[];
  return new Map(rows.map((r) => [r.id, summaryOf(r)]));
}

// ─────────────────────────────────────────────────────────────────────────────
// List / detail
// ─────────────────────────────────────────────────────────────────────────────

export interface ListCreditsInput {
  states?: CreditState[];
  accountId?: string;
  /** null = every branch (owner `all`); else `branch_id = b OR branch_id IS NULL`. */
  branchId: string | null;
  from?: string;
  to?: string;
  cursor?: string | null;
  limit?: number;
  viewerUserId: string;
}

export async function listCredits(
  tenantId: string,
  input: ListCreditsInput,
): Promise<{ data: CreditDTO[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(CREDITS_PAGE_MAX, input.limit ?? CREDITS_PAGE_DEFAULT));
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const f: SQL[] = [sql`c.is_test = false`];
  if (input.branchId) f.push(sql`(c.branch_id = ${input.branchId} OR c.branch_id IS NULL)`);
  if (input.states && input.states.length > 0) f.push(sql`c.state IN (${sql.join(input.states.map((s) => sql`${s}`), sql`, `)})`);
  if (input.accountId) f.push(sql`c.collection_account_id = ${input.accountId}`);
  if (input.from) f.push(sql`c.occurred_at >= ${input.from}::timestamptz`);
  if (input.to) f.push(sql`c.occurred_at <= ${input.to}::timestamptz`);
  if (cursor) f.push(sql`(c.occurred_at, c.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`);
  return withTenant(tenantId, async (tx) => {
    const rows = (await tx.execute(
      creditDtoQuery(tenantId, sql.join(f, sql` AND `), sql`ORDER BY c.occurred_at DESC, c.id DESC LIMIT ${limit + 1}`),
    )) as unknown as CreditDtoRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const linked = await linkedCollections(tx, tenantId, page);
    const last = page[page.length - 1];
    return {
      data: page.map((r) => toCreditDTO(r, linked, input.viewerUserId)),
      nextCursor: hasMore && last ? encodeCursor(last.occurred_key, last.id) : null,
    };
  });
}

/** Detail with ≤ 10 ranked candidates; `raw` only for an owner with includeRaw. */
export async function getCredit(
  tenantId: string,
  id: string,
  access: CreditAccess & { includeRaw: boolean },
): Promise<CreditDetailDTO | null> {
  return withTenant(tenantId, async (tx) => {
    const rows = (await tx.execute(creditDtoQuery(tenantId, sql`c.id = ${id}`))) as unknown as CreditDtoRow[];
    const r = rows[0];
    if (!r || !reachable(r.branch_id, access)) return null;
    const dto = toCreditDTO(r, await linkedCollections(tx, tenantId, rows), access.userId);
    const occ = dto.occurredAt;
    const template = templateById(r.template_id);
    const rail = template?.rail ?? (r.account_rail as CollectionRail | null);
    const window = sql`k.status = 'pending'
      AND k.amount <= ${r.amount}::numeric AND k.amount >= ${r.amount}::numeric - 5
      AND k.rung_at BETWEEN ${occ}::timestamptz - interval '72 hours' AND ${occ}::timestamptz + interval '2 hours'`;
    const scope = r.collection_account_id
      ? sql`(k.collection_account_id = ${r.collection_account_id} ${rail ? sql`OR (k.collection_account_id IS NULL AND k.method = ${rail})` : sql``})`
      : rail
        ? sql`k.method = ${rail}`
        : sql`true`;
    const ks = (await tx.execute(
      candidateQuery(tenantId, sql`${scope} AND ${window}`, sql`ORDER BY abs(extract(epoch FROM k.rung_at - ${occ}::timestamptz)), k.id LIMIT 30`),
    )) as unknown as CandidateRow[];
    const credit = {
      amount: r.amount,
      occurredAt: occ,
      accountId: r.collection_account_id,
      operatorReference: r.operator_reference,
      payerPhoneLast4: r.payer_phone_last4,
      templateId: r.template_id,
    };
    let candidates: CollectionCandidate[];
    if (r.collection_account_id) {
      const ranked = rankCandidates(
        {
          accountId: r.collection_account_id,
          rail,
          amount: r.amount,
          occurredAt: occ,
          operatorReference: r.operator_reference,
          operatorReferenceFormat: template?.referenceFormat ?? "none",
          payerPhoneLast4: r.payer_phone_last4,
        },
        ks.map((k) => ({
          id: k.id,
          status: k.status as CollectionStatus,
          accountId: k.collection_account_id,
          method: k.method as DigitalMethod,
          amount: k.amount,
          rungAt: k.rung_at,
          payerReference: k.payer_reference,
          payerPhoneLast4: k.payer_phone_last4,
          matchedCreditId: k.matched_credit_id,
        })),
      );
      const byId = new Map(ks.map((k) => [k.id, k]));
      candidates = ranked.slice(0, 10).map((x) => toCandidate(credit, byId.get(x.collectionId)!, access.userId));
    } else {
      // No account: equal-amount pending collections of the rail, closest first (suggestion only).
      candidates = ks
        .filter((k) => toPiasters(k.amount) === toPiasters(r.amount))
        .slice(0, 10)
        .map((k) => toCandidate(credit, k, access.userId));
    }
    let raw: CreditDetailDTO["raw"] = null;
    if (access.includeRaw && r.raw_message_id) {
      const rr = (await tx.execute(sql`
        SELECT title_enc, body_enc FROM collection_raw_messages WHERE tenant_id = ${tenantId} AND id = ${r.raw_message_id}
      `)) as unknown as { title_enc: string | null; body_enc: string | null }[];
      if (rr[0]?.body_enc) {
        const ts = decodeTitleSubtitle(decryptRawText(rr[0].title_enc));
        raw = { title: ts.title, subtitle: ts.subtitle, body: decryptRawText(rr[0].body_enc) ?? "" };
      }
    }
    return { ...dto, candidates, raw };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Match / ignore (§4.13)
// ─────────────────────────────────────────────────────────────────────────────

export interface CreditActor extends CreditAccess {
  isOwner: boolean;
}

export interface MatchResult {
  credit: CreditDTO;
  collection: { id: string; status: CollectionStatus };
  warnings: ("amount_differs" | "account_differs")[];
}

export async function matchCredit(
  tenantId: string,
  actor: CreditActor,
  creditId: string,
  collectionId: string,
): Promise<MatchResult> {
  try {
    const res = await withTenant(tenantId, async (tx) => {
      const [hc] = (await tx.execute(sql`
        SELECT collection_account_id, branch_id FROM collection_credits WHERE tenant_id = ${tenantId} AND id = ${creditId}
      `)) as unknown as { collection_account_id: string | null; branch_id: string | null }[];
      if (!hc || !reachable(hc.branch_id, actor)) throw new DomainError("CREDIT_NOT_FOUND", 404);
      const [hk] = (await tx.execute(sql`
        SELECT collection_account_id, branch_id, source_type, invoice_id FROM collections WHERE tenant_id = ${tenantId} AND id = ${collectionId}
      `)) as unknown as { collection_account_id: string | null; branch_id: string; source_type: string; invoice_id: string | null }[];
      if (!hk || !reachable(hk.branch_id, actor)) throw new DomainError("COLLECTION_NOT_FOUND", 404);

      await lockAccounts(tx, tenantId, [hc.collection_account_id, hk.collection_account_id]);
      const credit = await loadCreditForUpdate(tx, tenantId, creditId);
      if (!credit) throw new DomainError("CREDIT_NOT_FOUND", 404);
      if (credit.state === "matched") throw new DomainError("CREDIT_ALREADY_MATCHED", 409);
      if (credit.state === "info" || credit.isTest || credit.direction !== "credit") {
        throw new DomainError("CREDIT_NOT_MATCHABLE", 409);
      }
      if (hk.source_type === "sale" && hk.invoice_id) await lockInvoiceCollections(tx, tenantId, hk.invoice_id);
      const coll = await loadCollectionForUpdate(tx, tenantId, collectionId);
      if (!coll) throw new DomainError("COLLECTION_NOT_FOUND", 404);
      assertNotSelfDecision(coll, { isOwner: actor.isOwner, userId: actor.userId });

      const amountDiff = (toPiasters(credit.amount) - toPiasters(coll.amount)) / 100;
      const accountDiff = credit.accountId !== coll.collectionAccountId;
      let status: CollectionStatus;
      if (coll.status === "pending") {
        await tx.execute(sql`
          UPDATE collections
             SET status = 'confirmed', decided_by_user_id = ${actor.userId}, decided_at = now(),
                 matched_credit_id = ${credit.id}, updated_at = now()
           WHERE tenant_id = ${tenantId} AND id = ${coll.id}
        `);
        await insertCollectionEvent(tx, {
          tenantId,
          collectionId: coll.id,
          kind: "matched",
          fromStatus: "pending",
          toStatus: "confirmed",
          actorUserId: actor.userId,
          creditId: credit.id,
          details: { amountDiff, accountDiff },
        });
        status = "confirmed";
      } else if (coll.status === "confirmed" && coll.matchedCreditId == null) {
        await tx.execute(sql`
          UPDATE collections SET matched_credit_id = ${credit.id}, updated_at = now()
           WHERE tenant_id = ${tenantId} AND id = ${coll.id}
        `);
        await insertCollectionEvent(tx, {
          tenantId,
          collectionId: coll.id,
          kind: "evidence_attached",
          actorUserId: actor.userId,
          creditId: credit.id,
          details: { creditId: credit.id, source: "manual", amountDiff, accountDiff },
        });
        status = "confirmed";
      } else {
        throw new DomainError("COLLECTION_NOT_PENDING", 409, { status: coll.status });
      }

      await tx.execute(sql`
        UPDATE collection_credits
           SET state = 'matched', matched_collection_id = ${coll.id}, hold_reason = NULL, suggested_collection_id = NULL,
               decided_by_user_id = ${actor.userId}, decided_at = now(), updated_at = now()
         WHERE tenant_id = ${tenantId} AND id = ${credit.id}
      `);
      // A human-approved balance (03 §C.3, Tahweel rule): forward only.
      if (credit.balanceAfter != null && credit.accountId) {
        const acct = await loadAccountForEval(tx, tenantId, credit.accountId);
        if (acct?.balanceCheckEnabled) await moveBaseline(tx, tenantId, acct.id, credit.balanceAfter, credit.occurredAt);
      }
      await tx.execute(sql`
        UPDATE collection_credits SET suggested_collection_id = NULL, updated_at = now()
         WHERE id IN (
           SELECT id FROM collection_credits
            WHERE tenant_id = ${tenantId} AND suggested_collection_id = ${coll.id} AND id <> ${credit.id}
            LIMIT 20
         )
      `);
      if (coll.sourceType === "sale" && coll.invoiceId) await reconcileInvoiceCollectionStatus(tx, tenantId, coll.invoiceId);
      const dto = await readCreditDto(tx, tenantId, credit.id, actor.userId);
      const warnings: MatchResult["warnings"] = [];
      if (amountDiff !== 0) warnings.push("amount_differs");
      if (accountDiff) warnings.push("account_differs");
      return { credit: dto!, collection: { id: coll.id, status }, warnings, branchId: coll.branchId };
    });
    await bustInsightsCache(tenantId);
    const { branchId: _b, ...out } = res;
    return out;
  } catch (err) {
    if (isUniqueViolation(err, "collections_matched_credit_uq") || isUniqueViolation(err, "collection_credits_matched_uq")) {
      throw new DomainError("CREDIT_ALREADY_MATCHED", 409);
    }
    throw err;
  }
}

export async function ignoreCredit(
  tenantId: string,
  actor: CreditActor,
  creditId: string,
  body: { reason: IgnoreReason; note?: string | null },
): Promise<CreditDTO> {
  return withTenant(tenantId, async (tx) => {
    const [hc] = (await tx.execute(sql`
      SELECT collection_account_id, branch_id FROM collection_credits WHERE tenant_id = ${tenantId} AND id = ${creditId}
    `)) as unknown as { collection_account_id: string | null; branch_id: string | null }[];
    if (!hc || !reachable(hc.branch_id, actor)) throw new DomainError("CREDIT_NOT_FOUND", 404);
    await lockAccounts(tx, tenantId, [hc.collection_account_id]);
    const credit = await loadCreditForUpdate(tx, tenantId, creditId);
    if (!credit) throw new DomainError("CREDIT_NOT_FOUND", 404);
    if (credit.state === "matched") throw new DomainError("CREDIT_ALREADY_MATCHED", 409);
    await tx.execute(sql`
      UPDATE collection_credits
         SET state = 'ignored', ignored_reason = ${body.reason}, hold_reason = NULL,
             decided_by_user_id = ${actor.userId}, decided_at = now(), updated_at = now()
       WHERE tenant_id = ${tenantId} AND id = ${credit.id}
    `);
    // `personal` / `not_a_sale` say the money is real → the forward-only baseline rule.
    if ((body.reason === "personal" || body.reason === "not_a_sale") && credit.balanceAfter != null && credit.accountId) {
      const acct = await loadAccountForEval(tx, tenantId, credit.accountId);
      if (acct?.balanceCheckEnabled) await moveBaseline(tx, tenantId, acct.id, credit.balanceAfter, credit.occurredAt);
    }
    return (await readCreditDto(tx, tenantId, credit.id, actor.userId))!;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Paste (§4.13)
// ─────────────────────────────────────────────────────────────────────────────

/** Blank-line separated pieces, trimmed, empties dropped. */
export function splitPaste(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export async function pasteCredits(
  tenantId: string,
  actor: CreditActor,
  body: { text: string; sender?: string | null; accountId?: string | null },
  deps: { now?: () => Date } = {},
): Promise<{ results: PasteResult[]; accepted: number }> {
  const pieces = splitPaste(body.text);
  if (pieces.length > PASTE_MAX_PIECES) {
    throw new DomainError("INGEST_PAYLOAD_TOO_LARGE", 413, { maxPieces: PASTE_MAX_PIECES });
  }
  if (body.accountId) {
    const ok = await withTenant(tenantId, async (tx) =>
      (
        (await tx.execute(sql`
          SELECT id FROM collection_accounts WHERE tenant_id = ${tenantId} AND id = ${body.accountId!} AND archived_at IS NULL
        `)) as unknown as { id: string }[]
      ).length > 0,
    );
    if (!ok) throw new DomainError("COLLECTION_ACCOUNT_NOT_FOUND", 404);
  }
  const results: PasteResult[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const now = deps.now ? deps.now() : new Date();
    const m: IngestMessage = {
      fp: null,
      channel: "manual_paste",
      sourceApp: null,
      sender: body.sender?.trim() ? body.sender.trim().slice(0, 64) : null,
      title: null,
      subtitle: null,
      body: pieces[i]!,
      receivedAt: now.toISOString(),
      test: false,
    };
    const effects = newEffects();
    const o = await withTenant(tenantId, async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      return ingestOne(
        tx,
        { tenantId, device: null, forcedAccountId: body.accountId ?? null, paste: true },
        m,
        deps.now ? { now: deps.now } : {},
        effects,
      );
    });
    flushMatchEffects(tenantId, effects); // a paste never notifies; kept for any reconcile bust
    results.push({
      index: i,
      status: o.status,
      ...(o.reason ? { reason: o.reason } : {}),
      ...(o.creditId ? { creditId: o.creditId } : {}),
      ...(o.state ? { state: o.state } : {}),
      ...(o.holdReason !== undefined ? { holdReason: o.holdReason } : {}),
      ...(o.suggestedCollectionId !== undefined ? { suggestedCollectionId: o.suggestedCollectionId } : {}),
    });
  }
  return { results, accepted: results.filter((r) => r.status === "accepted").length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unrecognised messages (owner only, §4.10)
// ─────────────────────────────────────────────────────────────────────────────

interface RawRow {
  id: string;
  channel: string;
  source_app: string | null;
  sender: string | null;
  sender_kind: string;
  title_enc: string | null;
  body_enc: string | null;
  parse_status: string;
  template_id: string | null;
  received_at: string;
  ingest_device_id: string | null;
  device_label: string | null;
  shared_at: string | null;
  expires_at: string;
  created_key: string;
}

export async function listUnrecognised(
  tenantId: string,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<{ data: UnrecognisedDTO[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(CREDITS_PAGE_MAX, opts.limit ?? CREDITS_PAGE_DEFAULT));
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  return withTenant(tenantId, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT r.id, r.channel, r.source_app, r.sender, r.sender_kind, r.title_enc, r.body_enc, r.parse_status,
             r.template_id, r.received_at, r.ingest_device_id, d.label AS device_label, r.shared_at, r.expires_at,
             to_json(r.created_at) #>> '{}' AS created_key
        FROM collection_raw_messages r
        LEFT JOIN collection_ingest_devices d ON d.tenant_id = r.tenant_id AND d.id = r.ingest_device_id
       WHERE r.tenant_id = ${tenantId} AND r.parse_status IN ('unknown_format', 'fallback') AND r.expires_at > now()
         ${cursor ? sql`AND (r.created_at, r.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ${limit + 1}
    `)) as unknown as RawRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const data: UnrecognisedDTO[] = page.map((r) => {
      let ts = { title: null as string | null, subtitle: null as string | null };
      let body = "";
      try {
        ts = decodeTitleSubtitle(decryptRawText(r.title_enc));
        body = decryptRawText(r.body_enc) ?? "";
      } catch {
        body = "";
      }
      return {
        id: r.id,
        channel: r.channel as IngestChannel,
        sourceApp: r.source_app,
        sender: r.sender,
        senderKind: r.sender_kind as SenderKind,
        title: ts.title,
        subtitle: ts.subtitle,
        body,
        parseStatus: r.parse_status as "unknown_format" | "fallback",
        templateId: r.template_id,
        receivedAt: toIso(r.received_at)!,
        device: r.ingest_device_id && r.device_label != null ? { id: r.ingest_device_id, label: r.device_label } : null,
        sharedAt: toIso(r.shared_at),
        expiresAt: toIso(r.expires_at)!,
      };
    });
    const last = page[page.length - 1];
    return { data, nextCursor: hasMore && last ? encodeCursor(last.created_key, last.id) : null };
  });
}

/** "Send to TheStoro" — idempotent; retention becomes shared_at + 90 days. */
export async function shareUnrecognised(
  tenantId: string,
  userId: string,
  id: string,
): Promise<{ id: string; sharedAt: string; expiresAt: string; firstShare: boolean }> {
  return withTenant(tenantId, async (tx) => {
    const [before] = (await tx.execute(sql`
      SELECT shared_at FROM collection_raw_messages
       WHERE tenant_id = ${tenantId} AND id = ${id} AND parse_status IN ('unknown_format', 'fallback') AND expires_at > now()
       FOR UPDATE
    `)) as unknown as { shared_at: string | null }[];
    if (!before) throw new DomainError("NOT_FOUND", 404);
    const [row] = (await tx.execute(sql`
      UPDATE collection_raw_messages
         SET shared_at = COALESCE(shared_at, now()),
             shared_by_user_id = COALESCE(shared_by_user_id, ${userId}::uuid),
             expires_at = COALESCE(shared_at, now()) + make_interval(days => ${SHARE_RETENTION_DAYS})
       WHERE tenant_id = ${tenantId} AND id = ${id}
       RETURNING id, shared_at, expires_at
    `)) as unknown as { id: string; shared_at: string; expires_at: string }[];
    return { id: row!.id, sharedAt: toIso(row!.shared_at)!, expiresAt: toIso(row!.expires_at)!, firstShare: before.shared_at == null };
  });
}
