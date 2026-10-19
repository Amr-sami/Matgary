// Digital collections — credit ↔ collection matching, the DB half of 03 §C.8
// (spec 07 §4.9, §4.12, §4.15; the pure half is 06's match.ts).
//
// 05 wrote the M1 stubs; 07 owns this file from M2 and replaced the BODIES
// only — the exported signatures are binding (03 §B.4, 05 ARCH CHANGE
// REQUEST 7), so operations.ts and lib/repo/collections.ts did not change.
//
// Call sites:
//   - evaluateCredit      — the ingest pipeline (collection-ingest.ts), one
//                           credit at a time, under the per-account lock;
//   - reverseMatch        — inside the cart / legacy-sale transaction, right
//                           after the collection rows are written (§C.8 step 9);
//   - flushMatchEffects   — after that transaction commits (activity, fan-out,
//                           cache bust). Never throws;
//   - releaseCredits      — inside reopen and the "last line deleted → void"
//                           hook (§4.15);
//   - rematchRecentCredits — 13's `lateRematch` cron, per tenant.
//
// Lock rule (§4.7 step 5), for every path here and for 05's callers: the
// advisory lock hashtext(tenant || ':' || account) is taken BEFORE any
// FOR UPDATE on collections or collection_credits; several accounts are
// locked in ascending id order.
//
// Raw `sql` binds timestamps as ISO text with ::timestamptz casts, never a JS
// Date (the 874d358 mark-all-paid 500).

import { sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { resolveCollectionsFeatures, type TenantTx } from "@/lib/collections/flags";
import { isUniqueViolation } from "@/lib/api/idempotency";
import { logger } from "@/lib/logger";
import { logActivity } from "@/lib/repo/activity";
import { bustInsightsCache } from "@/lib/repo/insights";
import { fanoutEvent } from "@/lib/notifications/dispatch";
import { insertCollectionEvent, reconcileInvoiceCollectionStatus } from "@/lib/repo/collections";
import { decodeTitleSubtitle, decryptRawText } from "@/lib/collections/raw-text";
import {
  autoConfirmGate,
  balanceCheck,
  classifyLateArrival,
  decideMatch,
  rankCandidates,
} from "@matgary/domain/collections/match";
import { parseMessage } from "@matgary/domain/collections/parse";
import { templateById } from "@matgary/domain/collections/templates/index";
import type {
  BalanceCheckOutcome,
  CollectionRail,
  CollectionStatus,
  CollectionTemplate,
  CreditDirection,
  CreditState,
  DigitalMethod,
  HoldReason,
  IngestChannel,
  MatchCollection,
  MatchCredit,
  RankedCandidate,
  SenderKind,
} from "@matgary/domain/collections/types";

// ─────────────────────────────────────────────────────────────────────────────
// Effects (05's shapes; CreditNotify redefined by 07 §4.9)
// ─────────────────────────────────────────────────────────────────────────────

/** One `collection.unmatched_credit` fan-out (§4.12), payload per §4.2. */
export type CreditNotify = {
  creditId: string;
  branchId: string | null;
  payload: {
    creditId: string;
    accountId: string | null;
    accountLabel: string | null;
    amount: number;
    state: "unmatched" | "held";
    holdReason: string | null;
    suggestedCollectionId: string | null;
    rejectedCollectionId?: string | null;
  };
};

export type MatchEffects = {
  autoConfirmed: { collectionId: string; creditId: string; branchId: string }[];
  notify: CreditNotify[];
  bust: boolean;
};

/** Never mutated: callers that need to add effects build a new object. */
export const EMPTY_EFFECTS: MatchEffects = Object.freeze({
  autoConfirmed: [],
  notify: [],
  bust: false,
}) as MatchEffects;

/** A fresh, mutable accumulator. */
export function newEffects(): MatchEffects {
  return { autoConfirmed: [], notify: [], bust: false };
}

export function mergeEffects(into: MatchEffects, from: MatchEffects): MatchEffects {
  into.autoConfirmed.push(...from.autoConfirmed);
  into.notify.push(...from.notify);
  into.bust = into.bust || from.bust;
  return into;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────

export interface CreditForEval {
  id: string;
  tenantId: string;
  branchId: string | null;
  accountId: string | null;
  rawMessageId: string | null;
  ingestDeviceId: string | null;
  direction: CreditDirection;
  amount: string;
  balanceAfter: string | null;
  /** ISO. */
  occurredAt: string;
  operatorReference: string | null;
  payerPhoneLast4: string | null;
  sender: string | null;
  senderKind: SenderKind;
  isTest: boolean;
  state: CreditState;
  holdReason: HoldReason | null;
  suggestedCollectionId: string | null;
  matchedCollectionId: string | null;
  templateId: string;
  channels: IngestChannel[];
}

interface CreditSqlRow {
  id: string;
  tenant_id: string;
  branch_id: string | null;
  collection_account_id: string | null;
  raw_message_id: string | null;
  ingest_device_id: string | null;
  direction: string;
  amount: string;
  balance_after: string | null;
  occurred_at: string;
  operator_reference: string | null;
  payer_phone_last4: string | null;
  sender: string | null;
  sender_kind: string;
  is_test: boolean;
  state: string;
  hold_reason: string | null;
  suggested_collection_id: string | null;
  matched_collection_id: string | null;
  template_id: string;
  channels: string[];
}

/** The columns `creditFromRow` reads (shared by every credit SELECT here). */
export const CREDIT_EVAL_COLUMNS = sql.raw(`
  id, tenant_id, branch_id, collection_account_id, raw_message_id, ingest_device_id, direction,
  amount::text AS amount, balance_after::text AS balance_after,
  to_json(occurred_at) #>> '{}' AS occurred_at, operator_reference, payer_phone_last4,
  sender, sender_kind, is_test, state, hold_reason, suggested_collection_id, matched_collection_id,
  template_id, channels`);

export function creditFromRow(r: CreditSqlRow): CreditForEval {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    branchId: r.branch_id,
    accountId: r.collection_account_id,
    rawMessageId: r.raw_message_id,
    ingestDeviceId: r.ingest_device_id,
    direction: r.direction as CreditDirection,
    amount: r.amount,
    balanceAfter: r.balance_after,
    occurredAt: new Date(r.occurred_at).toISOString(),
    operatorReference: r.operator_reference,
    payerPhoneLast4: r.payer_phone_last4,
    sender: r.sender,
    senderKind: r.sender_kind as SenderKind,
    isTest: !!r.is_test,
    state: r.state as CreditState,
    holdReason: (r.hold_reason as HoldReason | null) ?? null,
    suggestedCollectionId: r.suggested_collection_id,
    matchedCollectionId: r.matched_collection_id,
    templateId: r.template_id,
    channels: (r.channels ?? []) as IngestChannel[],
  };
}

export async function loadCreditForUpdate(tx: TenantTx, tenantId: string, id: string): Promise<CreditForEval | null> {
  const rows = (await tx.execute(sql`
    SELECT ${CREDIT_EVAL_COLUMNS} FROM collection_credits WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE
  `)) as unknown as CreditSqlRow[];
  return rows[0] ? creditFromRow(rows[0]) : null;
}

export interface AccountForEval {
  id: string;
  label: string;
  rail: CollectionRail;
  branchId: string | null;
  autoConfirmEnabled: boolean;
  reviewThreshold: string;
  balanceCheckEnabled: boolean;
  balanceBaseline: string | null;
  balanceBaselineAt: string | null;
  balanceChainBrokenAt: string | null;
}

export async function loadAccountForEval(tx: TenantTx, tenantId: string, id: string): Promise<AccountForEval | null> {
  const rows = (await tx.execute(sql`
    SELECT id, label, rail, branch_id, auto_confirm_enabled, review_threshold::text AS review_threshold,
           balance_check_enabled, balance_baseline::text AS balance_baseline,
           to_json(balance_baseline_at) #>> '{}' AS balance_baseline_at,
           to_json(balance_chain_broken_at) #>> '{}' AS balance_chain_broken_at
      FROM collection_accounts WHERE tenant_id = ${tenantId} AND id = ${id}
  `)) as unknown as {
    id: string;
    label: string;
    rail: string;
    branch_id: string | null;
    auto_confirm_enabled: boolean;
    review_threshold: string;
    balance_check_enabled: boolean;
    balance_baseline: string | null;
    balance_baseline_at: string | null;
    balance_chain_broken_at: string | null;
  }[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    label: r.label,
    rail: r.rail as CollectionRail,
    branchId: r.branch_id,
    autoConfirmEnabled: !!r.auto_confirm_enabled,
    reviewThreshold: r.review_threshold,
    balanceCheckEnabled: !!r.balance_check_enabled,
    balanceBaseline: r.balance_baseline,
    balanceBaselineAt: r.balance_baseline_at,
    balanceChainBrokenAt: r.balance_chain_broken_at,
  };
}

interface CollectionCandRow {
  id: string;
  status: string;
  collection_account_id: string | null;
  method: string;
  amount: string;
  rung_at: string;
  payer_reference: string | null;
  payer_phone_last4: string | null;
  matched_credit_id: string | null;
  branch_id: string;
  invoice_id: string | null;
  source_type: string;
}

function toMatchCollection(r: CollectionCandRow): MatchCollection {
  return {
    id: r.id,
    status: r.status as CollectionStatus,
    accountId: r.collection_account_id,
    method: r.method as DigitalMethod,
    amount: r.amount,
    rungAt: new Date(r.rung_at).toISOString(),
    payerReference: r.payer_reference,
    payerPhoneLast4: r.payer_phone_last4,
    matchedCreditId: r.matched_credit_id,
  };
}

const CAND_COLUMNS = sql.raw(`
  id, status, collection_account_id, method, amount::text AS amount, to_json(rung_at) #>> '{}' AS rung_at,
  payer_reference, payer_phone_last4, matched_credit_id, branch_id, invoice_id, source_type`);

// ─────────────────────────────────────────────────────────────────────────────
// Locks
// ─────────────────────────────────────────────────────────────────────────────

/** §4.7 step 5 — `none` for a credit without an account. */
export async function lockAccount(tx: TenantTx, tenantId: string, accountId: string | null): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text || ':' || ${accountId ?? "none"}::text))`);
}

/** Several accounts, ascending id order (no lock-order cycle). */
export async function lockAccounts(tx: TenantTx, tenantId: string, accountIds: readonly (string | null)[]): Promise<void> {
  const ids = [...new Set(accountIds.map((a) => a ?? "none"))].sort();
  for (const id of ids) await lockAccount(tx, tenantId, id === "none" ? null : id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications (§4.12, D07-1)
// ─────────────────────────────────────────────────────────────────────────────

const NOTIFYING_HOLDS: ReadonlySet<string> = new Set(["no_account", "matches_rejected", "balance_mismatch", "suspicious_link"]);

/** D07-1: unmatched with no suggestion, or one of four holds; never a test
 *  or a manual paste. */
export function shouldNotifyCredit(c: {
  isTest: boolean;
  channels: readonly string[];
  state: string;
  holdReason: string | null;
  suggestedCollectionId: string | null;
}): boolean {
  if (c.isTest) return false;
  if (c.channels.length === 1 && c.channels[0] === "manual_paste") return false;
  if (c.state === "unmatched" && c.suggestedCollectionId == null) return true;
  if (c.state === "held" && c.holdReason != null && NOTIFYING_HOLDS.has(c.holdReason)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trust context (the gate's source facts)
// ─────────────────────────────────────────────────────────────────────────────

export interface EvalTrust {
  channel: IngestChannel;
  senderKind: SenderKind;
  senderMatched: boolean;
  suspiciousLinks: string[];
  /** null for a paste / an unknown device → `untrusted_source`. */
  device: { live: boolean; channels: IngestChannel[] } | null;
}

/**
 * For a re-evaluation (reverse match, late rematch): re-derive the sender
 * verdict and the link check from the raw message, which outlives the 72 h
 * rematch window (parsed rows are kept 7 days). No raw row (purged, revoked
 * device) or an undecryptable one → fail closed: no device, sender not
 * matched (`untrusted_source`), so a re-evaluation can never auto-confirm on
 * less evidence than the first pass had.
 */
export async function loadTrustForCredit(
  tx: TenantTx,
  credit: CreditForEval,
  templates?: readonly CollectionTemplate[],
): Promise<EvalTrust> {
  const closed: EvalTrust = {
    channel: credit.channels[0] ?? "manual_paste",
    senderKind: credit.senderKind,
    senderMatched: false,
    suspiciousLinks: [],
    device: null,
  };
  if (!credit.rawMessageId) return closed;
  const rows = (await tx.execute(sql`
    SELECT r.channel, r.sender, r.sender_kind, r.source_app, r.title_enc, r.body_enc,
           to_json(r.received_at) #>> '{}' AS received_at, r.ingest_device_id,
           d.revoked_at AS device_revoked_at, d.channels AS device_channels
      FROM collection_raw_messages r
      LEFT JOIN collection_ingest_devices d ON d.id = r.ingest_device_id AND d.tenant_id = r.tenant_id
     WHERE r.tenant_id = ${credit.tenantId} AND r.id = ${credit.rawMessageId}
  `)) as unknown as {
    channel: string;
    sender: string | null;
    sender_kind: string;
    source_app: string | null;
    title_enc: string | null;
    body_enc: string | null;
    received_at: string;
    ingest_device_id: string | null;
    device_revoked_at: string | null;
    device_channels: string[] | null;
  }[];
  const r = rows[0];
  if (!r || !r.body_enc) return closed;
  let body: string | null;
  let ts: { title: string | null; subtitle: string | null };
  try {
    body = decryptRawText(r.body_enc);
    ts = decodeTitleSubtitle(decryptRawText(r.title_enc));
  } catch {
    return closed;
  }
  if (!body) return closed;
  const channel = r.channel as IngestChannel;
  const p = parseMessage(
    { channel, sender: r.sender, sourceApp: r.source_app, title: ts.title, subtitle: ts.subtitle, body, receivedAt: r.received_at },
    { now: new Date(r.received_at), ...(templates ? { templates } : {}) },
  );
  return {
    channel,
    senderKind: r.sender_kind as SenderKind,
    senderMatched: p.senderMatched,
    suspiciousLinks: p.suspiciousLinks,
    device: r.ingest_device_id
      ? { live: r.device_revoked_at == null, channels: (r.device_channels ?? []) as IngestChannel[] }
      : null,
  };
}

/**
 * The balance verdict of a credit being RE-evaluated (§4.9 reverseMatch:
 * "not recomputed, the baseline is not moved twice"). An `unmatched` credit
 * on an applicable balance template passed the chain on its first pass (a
 * mismatch or missing baseline would have held it); a `held/ambiguous` one
 * may not have (ambiguity is decided before the balance holds), so it fails
 * closed to `no_baseline` — it can be suggested, never auto-confirmed.
 */
export function reEvaluationBalance(
  credit: Pick<CreditForEval, "state" | "balanceAfter">,
  template: CollectionTemplate | null,
  account: Pick<AccountForEval, "balanceCheckEnabled"> | null,
): BalanceCheckOutcome {
  const applicable = !!account?.balanceCheckEnabled && !!template?.hasBalance && credit.balanceAfter != null;
  if (!applicable) return "not_applicable";
  return credit.state === "unmatched" ? "pass" : "no_baseline";
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateCredit (§4.9 steps 1–8)
// ─────────────────────────────────────────────────────────────────────────────

export interface EvalCtx {
  template: CollectionTemplate | null;
  trust: EvalTrust;
  now: Date;
  /** `actor_device_id` of the events written. */
  deviceId: string | null;
  /** Set on a re-evaluation: use this verdict and never move the baseline. */
  balanceOverride?: BalanceCheckOutcome;
  /** The state before this evaluation (null = a new credit), for D07-1's
   *  "first time it reaches a notifying state". */
  previous: { state: CreditState; holdReason: HoldReason | null; suggestedCollectionId: string | null } | null;
  /** A manual paste never notifies (and never auto-confirms: `manual_source`). */
  isPaste?: boolean;
}

export interface EvalOutcome {
  state: CreditState;
  holdReason: HoldReason | null;
  suggestedCollectionId: string | null;
  matchedCollectionId: string | null;
  /** ≤ 10, the credit detail's `candidates`. */
  ranked: RankedCandidate[];
  autoConfirmedCollectionId: string | null;
}

function toMatchCredit(c: CreditForEval, template: CollectionTemplate | null, account: AccountForEval | null): MatchCredit {
  return {
    accountId: c.accountId,
    rail: template?.rail ?? account?.rail ?? null,
    amount: c.amount,
    occurredAt: c.occurredAt,
    operatorReference: c.operatorReference,
    operatorReferenceFormat: template?.referenceFormat ?? "none",
    payerPhoneLast4: c.payerPhoneLast4,
  };
}

async function setChainBroken(tx: TenantTx, tenantId: string, accountId: string, occurredAt: string): Promise<void> {
  await tx.execute(sql`
    UPDATE collection_accounts
       SET balance_chain_broken_at = greatest(coalesce(balance_chain_broken_at, '-infinity'::timestamptz), ${occurredAt}::timestamptz),
           updated_at = now()
     WHERE tenant_id = ${tenantId} AND id = ${accountId}
  `);
}

/** Forward-only baseline move (a pass, or a human decision, 03 §C.3). */
export async function moveBaseline(
  tx: TenantTx,
  tenantId: string,
  accountId: string,
  balance: string,
  occurredAt: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE collection_accounts
       SET balance_baseline = ${balance}::numeric, balance_baseline_at = ${occurredAt}::timestamptz, updated_at = now()
     WHERE tenant_id = ${tenantId} AND id = ${accountId}
       AND (balance_baseline_at IS NULL OR balance_baseline_at <= ${occurredAt}::timestamptz)
  `);
}

async function writeCreditState(tx: TenantTx, c: CreditForEval, o: EvalOutcome): Promise<void> {
  await tx.execute(sql`
    UPDATE collection_credits
       SET state = ${o.state}, hold_reason = ${o.holdReason}, suggested_collection_id = ${o.suggestedCollectionId},
           matched_collection_id = ${o.matchedCollectionId}, updated_at = now()
     WHERE tenant_id = ${c.tenantId} AND id = ${c.id}
  `);
}

/** Closest pending collection of the rail with an equal amount in the suggest window (no account → suggestion only). */
async function suggestionWithoutAccount(
  tx: TenantTx,
  c: CreditForEval,
  rail: CollectionRail | null,
): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT id FROM collections
     WHERE tenant_id = ${c.tenantId} AND status = 'pending' AND amount = ${c.amount}::numeric
       ${rail ? sql`AND method = ${rail}` : sql``}
       AND rung_at BETWEEN ${c.occurredAt}::timestamptz - interval '72 hours' AND ${c.occurredAt}::timestamptz + interval '2 hours'
     ORDER BY abs(extract(epoch FROM rung_at - ${c.occurredAt}::timestamptz)), id
     LIMIT 1
  `)) as unknown as { id: string }[];
  return rows[0]?.id ?? null;
}

/** The two indexed candidate queries of §4.9 step 6 (never an OR across the NULL-account set). */
async function loadCandidates(
  tx: TenantTx,
  c: CreditForEval,
  rail: CollectionRail | null,
): Promise<CollectionCandRow[]> {
  if (!c.accountId) return [];
  const onAccount = (await tx.execute(sql`
    SELECT ${CAND_COLUMNS} FROM collections
     WHERE tenant_id = ${c.tenantId} AND status = 'pending' AND collection_account_id = ${c.accountId}
       AND amount <= ${c.amount}::numeric AND amount >= ${c.amount}::numeric - 5
       AND rung_at BETWEEN ${c.occurredAt}::timestamptz - interval '72 hours' AND ${c.occurredAt}::timestamptz + interval '2 hours'
     ORDER BY abs(extract(epoch FROM rung_at - ${c.occurredAt}::timestamptz)), id
     LIMIT 20
     FOR UPDATE
  `)) as unknown as CollectionCandRow[];
  const noAccount = rail
    ? ((await tx.execute(sql`
        SELECT ${CAND_COLUMNS} FROM collections
         WHERE tenant_id = ${c.tenantId} AND status = 'pending' AND collection_account_id IS NULL AND method = ${rail}
           AND amount <= ${c.amount}::numeric AND amount >= ${c.amount}::numeric - 5
           AND rung_at BETWEEN ${c.occurredAt}::timestamptz - interval '72 hours' AND ${c.occurredAt}::timestamptz + interval '2 hours'
         ORDER BY abs(extract(epoch FROM rung_at - ${c.occurredAt}::timestamptz)), id
         LIMIT 5
         FOR UPDATE
      `)) as unknown as CollectionCandRow[])
    : [];
  return [...onAccount, ...noAccount];
}

/** Late arrivals (§4.9 step 7): confirmed / rejected collections of the account, equal amount, auto window. */
async function loadDecided(tx: TenantTx, c: CreditForEval): Promise<CollectionCandRow[]> {
  if (!c.accountId) return [];
  return (await tx.execute(sql`
    SELECT ${CAND_COLUMNS} FROM collections
     WHERE tenant_id = ${c.tenantId} AND status IN ('confirmed', 'rejected') AND collection_account_id = ${c.accountId}
       AND amount = ${c.amount}::numeric
       AND rung_at BETWEEN ${c.occurredAt}::timestamptz - interval '6 hours' AND ${c.occurredAt}::timestamptz + interval '30 minutes'
     ORDER BY abs(extract(epoch FROM rung_at - ${c.occurredAt}::timestamptz)), id
     LIMIT 5
     FOR UPDATE
  `)) as unknown as CollectionCandRow[];
}

/** Step 8: auto-confirm C with this credit, in a savepoint (a lost race →
 *  unique violation → null, the caller holds `ambiguous`). */
async function applyAuto(
  tx: TenantTx,
  c: CreditForEval,
  cand: CollectionCandRow,
  ctx: EvalCtx,
): Promise<"ok" | "not_pending" | "race"> {
  try {
    return await tx.transaction(async (sp) => {
      const upd = (await sp.execute(sql`
        UPDATE collections
           SET status = 'auto_confirmed', matched_credit_id = ${c.id}, decided_by_user_id = NULL,
               decided_at = now(), updated_at = now()
         WHERE tenant_id = ${c.tenantId} AND id = ${cand.id} AND status = 'pending'
         RETURNING id
      `)) as unknown as { id: string }[];
      if (upd.length === 0) return "not_pending" as const;
      await sp.execute(sql`
        UPDATE collection_credits
           SET state = 'matched', matched_collection_id = ${cand.id}, hold_reason = NULL,
               suggested_collection_id = NULL, updated_at = now()
         WHERE tenant_id = ${c.tenantId} AND id = ${c.id}
      `);
      await insertCollectionEvent(sp, {
        tenantId: c.tenantId,
        collectionId: cand.id,
        kind: "auto_confirmed",
        fromStatus: "pending",
        toStatus: "auto_confirmed",
        actorUserId: null,
        actorDeviceId: ctx.deviceId,
        creditId: c.id,
        details: { templateId: c.templateId },
      });
      if (cand.source_type === "sale" && cand.invoice_id) {
        await reconcileInvoiceCollectionStatus(sp, c.tenantId, cand.invoice_id);
      }
      return "ok" as const;
    });
  } catch (err) {
    if (isUniqueViolation(err, "collections_matched_credit_uq") || isUniqueViolation(err, "collection_credits_matched_uq")) {
      return "race";
    }
    throw err;
  }
}

/** Late-arrival evidence: link both ways, collection status unchanged. */
async function attachEvidence(tx: TenantTx, c: CreditForEval, collectionId: string, ctx: EvalCtx): Promise<boolean> {
  try {
    return await tx.transaction(async (sp) => {
      const upd = (await sp.execute(sql`
        UPDATE collections SET matched_credit_id = ${c.id}, updated_at = now()
         WHERE tenant_id = ${c.tenantId} AND id = ${collectionId} AND matched_credit_id IS NULL
         RETURNING id
      `)) as unknown as { id: string }[];
      if (upd.length === 0) return false;
      await insertCollectionEvent(sp, {
        tenantId: c.tenantId,
        collectionId,
        kind: "evidence_attached",
        actorUserId: null,
        actorDeviceId: ctx.deviceId,
        creditId: c.id,
        details: { creditId: c.id, source: "auto" },
      });
      return true;
    });
  } catch (err) {
    if (isUniqueViolation(err, "collections_matched_credit_uq") || isUniqueViolation(err, "collection_credits_matched_uq")) {
      return false;
    }
    throw err;
  }
}

/**
 * Steps 1–8 of §4.9 for one credit (the caller holds the account lock and
 * has the credit row FOR UPDATE). Writes the credit's state, the account's
 * balance chain, collection status / events, and pushes notify / auto
 * effects. Returns the outcome (ranked candidates for the detail view).
 */
export async function evaluateCredit(
  tx: TenantTx,
  credit: CreditForEval,
  ctx: EvalCtx,
  effects: MatchEffects,
  retried = false,
): Promise<EvalOutcome> {
  const tenantId = credit.tenantId;
  const template = ctx.template;
  const account = credit.accountId ? await loadAccountForEval(tx, tenantId, credit.accountId) : null;
  const out: EvalOutcome = {
    state: "unmatched",
    holdReason: null,
    suggestedCollectionId: null,
    matchedCollectionId: null,
    ranked: [],
    autoConfirmedCollectionId: null,
  };
  let rejectedCollectionId: string | null = null;

  const bc = () =>
    balanceCheck({
      enabled: account?.balanceCheckEnabled ?? false,
      template,
      direction: credit.direction,
      amount: credit.amount,
      balanceAfter: credit.balanceAfter,
      baseline: account?.balanceBaseline ?? null,
      baselineAt: account?.balanceBaselineAt ?? null,
      chainBrokenAt: account?.balanceChainBrokenAt ?? null,
    });

  if (credit.direction === "debit") {
    // 1 — a debit is information and breaks the chain.
    out.state = "info";
    if (account && account.balanceCheckEnabled && ctx.balanceOverride === undefined) {
      await setChainBroken(tx, tenantId, account.id, credit.occurredAt);
    }
  } else if (credit.direction === "cash_in") {
    // 2 — an agent deposit: never a sale, but the chain treats it like a credit.
    out.state = "info";
    if (account && ctx.balanceOverride === undefined) {
      const v = bc();
      if (v.result === "pass" && v.newBaseline) await moveBaseline(tx, tenantId, account.id, v.newBaseline, credit.occurredAt);
      else if (v.result === "mismatch" || v.result === "breaks_chain") await setChainBroken(tx, tenantId, account.id, credit.occurredAt);
    }
  } else if (credit.isTest) {
    // 3
    out.state = "held";
    out.holdReason = "test";
  } else if (!account) {
    // 4 — suggestion only.
    out.state = "held";
    out.holdReason = "no_account";
    out.suggestedCollectionId = await suggestionWithoutAccount(tx, credit, template?.rail ?? null);
  } else {
    // 5 — balance verdict; the DB side only on a first evaluation.
    let verdict: BalanceCheckOutcome;
    if (ctx.balanceOverride !== undefined) {
      verdict = ctx.balanceOverride;
    } else {
      const v = bc();
      verdict = v.result;
      if (v.result === "pass" && v.newBaseline) await moveBaseline(tx, tenantId, account.id, v.newBaseline, credit.occurredAt);
      else if (v.result === "breaks_chain") await setChainBroken(tx, tenantId, account.id, credit.occurredAt);
    }

    // 6 — candidates, rank, decide (06).
    const candRows = await loadCandidates(tx, credit, template?.rail ?? account.rail);
    const byId = new Map(candRows.map((r) => [r.id, r]));
    const ranked = rankCandidates(toMatchCredit(credit, template, account), candRows.map(toMatchCollection));
    out.ranked = ranked.slice(0, 10);
    const decision = decideMatch(ranked);

    // 7 — outcome.
    if (decision.kind === "hold") {
      out.state = "held";
      out.holdReason = decision.reason;
      out.suggestedCollectionId = decision.suggestedCollectionId;
    } else if (decision.kind === "auto") {
      const cand = byId.get(decision.collectionId)!;
      const features = await resolveCollectionsFeatures(tenantId, cand.branch_id, tx);
      const gate = autoConfirmGate({
        autoConfirmFeature: features.collectionsAutoConfirm,
        account: { autoConfirmEnabled: account.autoConfirmEnabled, reviewThreshold: account.reviewThreshold },
        template,
        channel: ctx.trust.channel,
        senderKind: ctx.trust.senderKind,
        senderMatched: ctx.trust.senderMatched,
        device: ctx.trust.device,
        amount: credit.amount,
        occurredAt: credit.occurredAt,
        reference: credit.operatorReference,
        suspiciousLinks: ctx.trust.suspiciousLinks,
        isTest: credit.isTest,
        balance: verdict,
        now: ctx.now,
      });
      if (!gate.pass) {
        out.state = "held";
        out.holdReason = gate.reason;
        out.suggestedCollectionId = cand.id;
      } else {
        // 8 — apply auto.
        const applied = await applyAuto(tx, credit, cand, ctx);
        if (applied === "ok") {
          out.state = "matched";
          out.matchedCollectionId = cand.id;
          out.autoConfirmedCollectionId = cand.id;
          effects.autoConfirmed.push({ collectionId: cand.id, creditId: credit.id, branchId: cand.branch_id });
          effects.bust = true;
          return out; // applyAuto wrote the credit row
        }
        if (applied === "not_pending" && !retried) {
          return evaluateCredit(tx, credit, { ...ctx, balanceOverride: verdict }, effects, true);
        }
        out.state = "held";
        out.holdReason = "ambiguous";
        out.suggestedCollectionId = cand.id;
      }
    } else {
      // unmatched(C | null) → late arrivals, but only for a credit with NO
      // pending candidate (03 §C.8 step 10). With unmatched(C) a pending sale
      // of this amount on this account is still waiting (a conflicting
      // suggestion, or one outside the auto window): linking the credit to
      // an older sale decided by hand would hide that sale's money (N-match).
      const decided = decision.suggestedCollectionId === null ? await loadDecided(tx, credit) : [];
      const late = classifyLateArrival(toMatchCredit(credit, template, account), decided.map(toMatchCollection));
      if (late.kind === "evidence" && (await attachEvidence(tx, credit, late.collectionId, ctx))) {
        out.state = "matched";
        out.matchedCollectionId = late.collectionId;
      } else if (late.kind === "matches_rejected") {
        out.state = "held";
        out.holdReason = "matches_rejected";
        out.suggestedCollectionId = late.collectionId;
        rejectedCollectionId = late.collectionId;
        const already =
          ctx.previous?.state === "held" &&
          ctx.previous.holdReason === "matches_rejected" &&
          ctx.previous.suggestedCollectionId === late.collectionId;
        if (!already) {
          await insertCollectionEvent(tx, {
            tenantId,
            collectionId: late.collectionId,
            kind: "note",
            actorUserId: null,
            actorDeviceId: ctx.deviceId,
            creditId: credit.id,
            details: { creditId: credit.id, reason: "matches_rejected" },
          });
        }
      } else if (verdict === "mismatch") {
        out.state = "held";
        out.holdReason = "balance_mismatch";
        out.suggestedCollectionId = decision.suggestedCollectionId;
      } else if (template?.autoConfirm === "balance" && (verdict === "no_baseline" || verdict === "breaks_chain")) {
        out.state = "held";
        out.holdReason = "no_balance_baseline";
        out.suggestedCollectionId = decision.suggestedCollectionId;
      } else {
        out.state = "unmatched";
        out.suggestedCollectionId = decision.suggestedCollectionId;
      }
    }
  }

  await writeCreditState(tx, credit, out);

  const after = {
    isTest: credit.isTest,
    channels: credit.channels,
    state: out.state,
    holdReason: out.holdReason,
    suggestedCollectionId: out.suggestedCollectionId,
  };
  const before = ctx.previous ? { ...after, ...ctx.previous } : null;
  if (!ctx.isPaste && shouldNotifyCredit(after) && !(before && shouldNotifyCredit(before))) {
    effects.notify.push({
      creditId: credit.id,
      branchId: credit.branchId,
      payload: {
        creditId: credit.id,
        accountId: credit.accountId,
        accountLabel: account?.label ?? null,
        amount: Number(credit.amount),
        state: out.state as "unmatched" | "held",
        holdReason: out.holdReason,
        suggestedCollectionId: out.suggestedCollectionId,
        ...(rejectedCollectionId ? { rejectedCollectionId } : {}),
      },
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-evaluation of an existing credit (reverse match, late rematch)
// ─────────────────────────────────────────────────────────────────────────────

async function reEvaluate(
  tx: TenantTx,
  credit: CreditForEval,
  effects: MatchEffects,
  now: Date,
): Promise<EvalOutcome> {
  const template = templateById(credit.templateId);
  const account = credit.accountId ? await loadAccountForEval(tx, credit.tenantId, credit.accountId) : null;
  const trust = await loadTrustForCredit(tx, credit);
  return evaluateCredit(
    tx,
    credit,
    {
      template,
      trust,
      now,
      deviceId: credit.ingestDeviceId,
      balanceOverride: reEvaluationBalance(credit, template, account),
      previous: { state: credit.state, holdReason: credit.holdReason, suggestedCollectionId: credit.suggestedCollectionId },
      isPaste: credit.channels.length === 1 && credit.channels[0] === "manual_paste",
    },
    effects,
  );
}

/**
 * Called by 05 inside the cart / settle transaction, so the new rows are
 * visible (§4.9). For each new pending collection with an account, in
 * ascending account order (advisory lock first): the account's unmatched /
 * held-ambiguous credits that fit X re-run steps 6–8; then credits held
 * no_account / balance_mismatch / no_balance_baseline with no suggestion get
 * X as a suggestion. Collections without an account are skipped.
 */
export async function reverseMatch(
  tx: TenantTx,
  tenantId: string,
  collectionIds: string[],
): Promise<MatchEffects> {
  if (collectionIds.length === 0) return EMPTY_EFFECTS;
  const effects = newEffects();
  const rows = (await tx.execute(sql`
    SELECT ${CAND_COLUMNS} FROM collections
     WHERE tenant_id = ${tenantId} AND id IN (${sql.join(collectionIds.map((id) => sql`${id}::uuid`), sql`, `)})
       AND status = 'pending' AND collection_account_id IS NOT NULL
  `)) as unknown as CollectionCandRow[];
  if (rows.length === 0) return EMPTY_EFFECTS;
  rows.sort((a, b) => (a.collection_account_id! < b.collection_account_id! ? -1 : a.collection_account_id! > b.collection_account_id! ? 1 : a.id < b.id ? -1 : 1));
  await lockAccounts(tx, tenantId, rows.map((r) => r.collection_account_id));
  const now = new Date();

  for (const x of rows) {
    const credits = (await tx.execute(sql`
      SELECT ${CREDIT_EVAL_COLUMNS} FROM collection_credits
       WHERE tenant_id = ${tenantId} AND collection_account_id = ${x.collection_account_id}
         AND direction = 'credit' AND is_test = false
         AND (state = 'unmatched' OR (state = 'held' AND hold_reason = 'ambiguous'))
         AND amount >= ${x.amount}::numeric AND amount <= ${x.amount}::numeric + 5
         AND occurred_at BETWEEN ${x.rung_at}::timestamptz - interval '2 hours' AND ${x.rung_at}::timestamptz + interval '72 hours'
       ORDER BY occurred_at, id
       LIMIT 20
       FOR UPDATE
    `)) as unknown as CreditSqlRow[];
    for (const row of credits) {
      // Earlier iterations may have matched this credit or this collection.
      const fresh = await loadCreditForUpdate(tx, tenantId, row.id);
      if (!fresh || !(fresh.state === "unmatched" || (fresh.state === "held" && fresh.holdReason === "ambiguous"))) continue;
      await reEvaluate(tx, fresh, effects, now);
    }
    await tx.execute(sql`
      UPDATE collection_credits
         SET suggested_collection_id = ${x.id}, updated_at = now()
       WHERE tenant_id = ${tenantId} AND state = 'held' AND suggested_collection_id IS NULL
         AND is_test = false AND direction = 'credit'
         AND amount = ${x.amount}::numeric
         AND occurred_at BETWEEN ${x.rung_at}::timestamptz - interval '2 hours' AND ${x.rung_at}::timestamptz + interval '72 hours'
         AND (
           (collection_account_id = ${x.collection_account_id} AND hold_reason IN ('balance_mismatch', 'no_balance_baseline'))
           OR (collection_account_id IS NULL AND hold_reason = 'no_account')
         )
    `);
  }
  return effects;
}

/**
 * 13's `lateRematch` (§4.9): credits younger than `maxAgeHours` in
 * `unmatched` or `held/ambiguous`, oldest first, each in its own transaction
 * with its account lock → steps 6–8 (the gate's `too_old` makes anything past
 * 48 h suggestion-only). Effects are flushed here.
 */
export async function rematchRecentCredits(
  tenantId: string,
  opts: { maxAgeHours?: number; limit?: number } = {},
): Promise<{ examined: number; autoConfirmed: number; suggested: number }> {
  const maxAgeHours = opts.maxAgeHours ?? 72;
  const limit = opts.limit ?? 200;
  const ids = await withTenant(tenantId, async (tx) =>
    (
      (await tx.execute(sql`
        SELECT id, collection_account_id FROM collection_credits
         WHERE tenant_id = ${tenantId} AND direction = 'credit' AND is_test = false
           AND occurred_at > now() - make_interval(hours => ${maxAgeHours})
           AND (state = 'unmatched' OR (state = 'held' AND hold_reason = 'ambiguous'))
         ORDER BY occurred_at, id
         LIMIT ${limit}
      `)) as unknown as { id: string; collection_account_id: string | null }[]
    ),
  );
  const effects = newEffects();
  let autoConfirmed = 0;
  let suggested = 0;
  for (const { id, collection_account_id } of ids) {
    try {
      await withTenant(tenantId, async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
        await lockAccount(tx, tenantId, collection_account_id);
        const credit = await loadCreditForUpdate(tx, tenantId, id);
        if (!credit || !(credit.state === "unmatched" || (credit.state === "held" && credit.holdReason === "ambiguous"))) return;
        const before = credit.suggestedCollectionId;
        const o = await reEvaluate(tx, credit, effects, new Date());
        if (o.autoConfirmedCollectionId) autoConfirmed++;
        else if (o.suggestedCollectionId && o.suggestedCollectionId !== before) suggested++;
      });
    } catch (err) {
      logger.warn({
        event: "collections.rematch_failed",
        tenantId,
        creditId: id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  flushMatchEffects(tenantId, effects);
  return { examined: ids.length, autoConfirmed, suggested };
}

// ─────────────────────────────────────────────────────────────────────────────
// flushMatchEffects (after commit; never throws)
// ─────────────────────────────────────────────────────────────────────────────

/** Activity `collection.auto_confirm` (null actor), one fan-out per notify
 *  entry, `bustInsightsCache` when anything was confirmed. Fire-and-forget:
 *  a committed sale or ingest batch is never turned into a 500 here. */
export function flushMatchEffects(tenantId: string, effects: MatchEffects): void {
  try {
    for (const a of effects.autoConfirmed) {
      void logActivity({
        tenantId,
        actorUserId: null,
        action: "collection.auto_confirm",
        category: "collection",
        entityType: "collection",
        entityId: a.collectionId,
        branchId: a.branchId,
        metadata: { creditId: a.creditId },
      }).catch(() => {});
    }
    for (const n of effects.notify) {
      void fanoutEvent(tenantId, n.branchId, "collection.unmatched_credit", n.payload).catch(() => {});
    }
    if (effects.bust) void bustInsightsCache(tenantId).catch(() => {});
  } catch (err) {
    logger.warn({
      event: "collections.flush_effects_failed",
      tenantId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// releaseCredits (§4.15)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called by 05 inside its transaction: on reopen (`reopened`, the collection
 * is pending again) and when an invoice's last line is deleted
 * (`sale_deleted`, the collection is void). Matched credits go back to
 * `unmatched` with no suggestion and both link columns cleared, one `note`
 * per released credit; the baseline is NOT touched. `sale_deleted` also
 * clears every other credit's suggestion pointing at those collections. No
 * re-evaluation and no fan-out here (13's lateRematch re-runs them).
 */
export async function releaseCredits(
  tx: TenantTx,
  tenantId: string,
  collectionIds: string[],
  reason: "reopened" | "sale_deleted",
): Promise<void> {
  if (collectionIds.length === 0) return;
  const idList = sql.join(collectionIds.map((id) => sql`${id}::uuid`), sql`, `);
  const accounts = (await tx.execute(sql`
    SELECT DISTINCT collection_account_id FROM collection_credits
     WHERE tenant_id = ${tenantId} AND (matched_collection_id IN (${idList}) OR suggested_collection_id IN (${idList}))
  `)) as unknown as { collection_account_id: string | null }[];
  await lockAccounts(tx, tenantId, accounts.map((a) => a.collection_account_id));

  const matched = (await tx.execute(sql`
    SELECT id, matched_collection_id FROM collection_credits
     WHERE tenant_id = ${tenantId} AND matched_collection_id IN (${idList})
     ORDER BY id
     FOR UPDATE
  `)) as unknown as { id: string; matched_collection_id: string }[];
  if (matched.length > 0) {
    await tx.execute(sql`
      UPDATE collections SET matched_credit_id = NULL, updated_at = now()
       WHERE tenant_id = ${tenantId} AND id IN (${idList}) AND matched_credit_id IS NOT NULL
    `);
    await tx.execute(sql`
      UPDATE collection_credits
         SET state = 'unmatched', matched_collection_id = NULL, hold_reason = NULL, suggested_collection_id = NULL,
             decided_by_user_id = NULL, decided_at = NULL, updated_at = now()
       WHERE tenant_id = ${tenantId} AND id IN (${sql.join(matched.map((m) => sql`${m.id}::uuid`), sql`, `)})
    `);
    for (const m of matched) {
      await insertCollectionEvent(tx, {
        tenantId,
        collectionId: m.matched_collection_id,
        kind: "note",
        creditId: m.id,
        details: { creditId: m.id, reason: "credit_released", cause: reason },
      });
    }
  }
  if (reason === "sale_deleted") {
    await tx.execute(sql`
      UPDATE collection_credits SET suggested_collection_id = NULL, updated_at = now()
       WHERE tenant_id = ${tenantId} AND suggested_collection_id IN (${idList}) AND state IN ('unmatched', 'held')
    `);
  }
}
