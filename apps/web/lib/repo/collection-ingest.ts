// Digital collections L2 — the ingest pipeline, per message (spec 07 §4.7;
// 03 §C.2, §C.8, §C.9). Also the manual paste's core (07 §4.13) and the raw
// purge 13's cron calls (§4.10).
//
// Messages run SEQUENTIALLY, one `withTenant` transaction each with
// `lock_timeout = 5s`. An unexpected error aborts the request with 500; the
// phone retries the batch and the already-committed messages come back
// `duplicate` (raw fp dedupe). `deps` exists only so tests can inject a
// template registry / clock; production passes nothing.
//
// Every rule that is a pure decision is 06's (`parseMessage`, `isOtp`,
// `senderKindOf`, `routeCredit`, `creditDedupeKey`, `shouldMergeCrossChannel`,
// `clientFingerprint`, `phoneLast4`, `maskPayerName`, the matcher); this file
// only does the IO around them. Timestamps are bound as ISO text with
// ::timestamptz casts, never as a JS Date.

import { sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import type { TenantTx } from "@/lib/collections/flags";
import type { IngestDeviceContext } from "@/lib/api/ingest-token";
import {
  bodySha256,
  encodeTitleSubtitle,
  encryptRawText,
  payerPhoneHmac,
  rawExpiresAt,
} from "@/lib/collections/raw-text";
import {
  CREDIT_EVAL_COLUMNS,
  creditFromRow,
  evaluateCredit,
  flushMatchEffects,
  lockAccount,
  newEffects,
  reEvaluationBalance,
  loadAccountForEval,
  type CreditForEval,
  type EvalTrust,
  type MatchEffects,
} from "@/lib/repo/collection-matching";
import { touchDeviceAfterBatch } from "@/lib/repo/collection-devices";
import { creditDedupeKey, clientFingerprint, shouldMergeCrossChannel } from "@matgary/domain/collections/dedupe";
import { isOtp } from "@matgary/domain/collections/filter";
import { MATCH_CONSTANTS, routeCredit } from "@matgary/domain/collections/match";
import { maskPayerName, phoneLast4, senderKindOf } from "@matgary/domain/collections/normalize";
import { FALLBACK_TEMPLATE_ID, messageText, parseMessage } from "@matgary/domain/collections/parse";
import { COLLECTION_TEMPLATES } from "@matgary/domain/collections/templates/index";
import type {
  CollectionProvider,
  CollectionRail,
  CollectionTemplate,
  CreditState,
  HoldReason,
  IngestChannel,
  IngestResultReason,
  ParseResult,
  ParseStatus,
  RouteAccount,
} from "@matgary/domain/collections/types";

export const INGEST_BODY_STORED_MAX = 2000;
const HOUR_MS = 3_600_000;
const FUTURE_SLACK_MS = 5 * 60_000;

/** One message as the routes hand it over (already validated + truncated). */
export interface IngestMessage {
  /** null only for a paste (07 computes 06's manual_paste fingerprint). */
  fp: string | null;
  channel: IngestChannel;
  sourceApp: string | null;
  sender: string | null;
  title: string | null;
  subtitle: string | null;
  body: string;
  /** ISO 8601 (Z or ±hh:mm). */
  receivedAt: string;
  test: boolean;
}

export interface IngestResult {
  fp: string;
  status: "accepted" | "duplicate" | "dropped";
  reason?: IngestResultReason;
}

/** What one message came to (the paste result reads all of it). */
export interface OneOutcome {
  status: "accepted" | "duplicate" | "dropped";
  reason?: IngestResultReason;
  creditId?: string;
  state?: CreditState;
  holdReason?: HoldReason | null;
  suggestedCollectionId?: string | null;
  /** direction credit, not a test, created or merged → last_credit_at. */
  realCredit: boolean;
}

export interface IngestDeps {
  now?: () => Date;
  /** Template registry override (tests inject a `pilot_verified` copy). */
  templates?: readonly CollectionTemplate[];
}

export interface IngestSource {
  tenantId: string;
  /** null for a paste. */
  device: IngestDeviceContext | null;
  /** A paste with `accountId`: skips routing (validated by the caller). */
  forcedAccountId: string | null;
  paste: boolean;
}

const NEVER_DEVICE_CHANNELS: ReadonlySet<IngestChannel> = new Set<IngestChannel>(["manual_paste", "statement"]);

function lookupTemplate(id: string | null, deps: IngestDeps): CollectionTemplate | null {
  if (!id || id === FALLBACK_TEMPLATE_ID) return null;
  return (deps.templates ?? COLLECTION_TEMPLATES).find((t) => t.id === id) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw rows
// ─────────────────────────────────────────────────────────────────────────────

interface RawInsert {
  tenantId: string;
  deviceId: string | null;
  channel: IngestChannel;
  sourceApp: string | null;
  sender: string | null;
  senderKind: string;
  fp: string;
  bodySha: string;
  receivedAt: string;
}

/** Step 2: the raw dedupe insert; null = this device already sent this fp. */
async function insertRaw(tx: TenantTx, r: RawInsert): Promise<string | null> {
  const rows = (await tx.execute(sql`
    INSERT INTO collection_raw_messages
      (tenant_id, ingest_device_id, channel, source_app, sender, sender_kind, client_fingerprint,
       body_sha256, parse_status, received_at, expires_at)
    VALUES (${r.tenantId}, ${r.deviceId}, ${r.channel}, ${r.sourceApp}, ${r.sender}, ${r.senderKind}, ${r.fp},
            ${r.bodySha}, 'parsed', ${r.receivedAt}::timestamptz, now() + interval '2 days')
    ON CONFLICT (tenant_id, ingest_device_id, client_fingerprint) WHERE client_fingerprint IS NOT NULL DO NOTHING
    RETURNING id
  `)) as unknown as { id: string }[];
  return rows[0]?.id ?? null;
}

/** Step 8 (and the early exits): final status, template, text, expiry. */
async function finishRaw(
  tx: TenantTx,
  tenantId: string,
  rawId: string,
  status: ParseStatus,
  opts: {
    templateId: string | null;
    text: { title: string | null; subtitle: string | null; body: string } | null;
    test: boolean;
    now: Date;
  },
): Promise<void> {
  const titleEnc = opts.text ? encodeTitleSubtitle(opts.text.title, opts.text.subtitle) : null;
  const expires = rawExpiresAt(status, { test: opts.test, now: opts.now }).toISOString();
  await tx.execute(sql`
    UPDATE collection_raw_messages
       SET parse_status = ${status}, template_id = ${opts.templateId},
           title_enc = ${titleEnc ? encryptRawText(titleEnc) : null},
           body_enc = ${opts.text ? encryptRawText(opts.text.body) : null},
           expires_at = ${expires}::timestamptz
     WHERE tenant_id = ${tenantId} AND id = ${rawId}
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing (§4.7 step 4) — 06's routeCredit over the tenant's active accounts
// ─────────────────────────────────────────────────────────────────────────────

interface AccountRouteRow {
  id: string;
  provider: string;
  rail: string;
  account_last4: string | null;
  wallet_msisdn: string | null;
  is_prepaid_card: boolean;
  branch_id: string | null;
}

async function activeAccounts(tx: TenantTx, tenantId: string): Promise<AccountRouteRow[]> {
  return (await tx.execute(sql`
    SELECT id, provider, rail, account_last4, wallet_msisdn, is_prepaid_card, branch_id
      FROM collection_accounts
     WHERE tenant_id = ${tenantId} AND archived_at IS NULL
     ORDER BY id
  `)) as unknown as AccountRouteRow[];
}

export async function routeCreditToAccount(
  tx: TenantTx,
  src: IngestSource,
  template: CollectionTemplate | null,
  receivingHint: string | null,
): Promise<{ accountId: string | null; branchId: string | null }> {
  const accounts = await activeAccounts(tx, src.tenantId);
  const fallbackBranch = src.device?.branchId ?? null;
  if (src.forcedAccountId) {
    const a = accounts.find((x) => x.id === src.forcedAccountId);
    return { accountId: a?.id ?? null, branchId: a?.branch_id ?? fallbackBranch };
  }
  const routeAccounts: RouteAccount[] = accounts.map((a) => ({
    id: a.id,
    provider: a.provider as CollectionProvider,
    rail: a.rail as CollectionRail,
    accountLast4: a.account_last4,
    walletMsisdn: a.wallet_msisdn,
    isPrepaidCard: !!a.is_prepaid_card,
  }));
  const r = routeCredit({
    template,
    receivingHint,
    accounts: routeAccounts,
    deviceAccountIds: src.device?.accountIds ?? [],
  });
  if (!r.accountId) return { accountId: null, branchId: fallbackBranch };
  const a = accounts.find((x) => x.id === r.accountId)!;
  return { accountId: a.id, branchId: a.branch_id ?? fallbackBranch };
}

async function storePayerNames(tx: TenantTx, tenantId: string, branchId: string | null): Promise<boolean> {
  if (!branchId) return false; // a NULL branch stores the masked name only (§4.7)
  const rows = (await tx.execute(sql`
    SELECT collections_store_payer_names FROM shop_settings WHERE tenant_id = ${tenantId} AND branch_id = ${branchId}
  `)) as unknown as { collections_store_payer_names: boolean }[];
  return !!rows[0]?.collections_store_payer_names;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dedupe / merge (§4.7 step 6, 03 §C.9)
// ─────────────────────────────────────────────────────────────────────────────

interface Incoming {
  provider: CollectionProvider | null;
  accountId: string | null;
  branchId: string | null;
  direction: "credit" | "debit" | "cash_in";
  templateId: string;
  amount: string;
  balanceAfter: string | null;
  reference: string | null;
  receivingHint: string | null;
  payerPhoneLast4: string | null;
  payerPhoneHmac: string | null;
  payerNameMasked: string | null;
  payerName: string | null;
  sender: string | null;
  senderKind: string;
  occurredAt: string;
  receivedAt: string;
  channel: IngestChannel;
  isTest: boolean;
  rawId: string;
  bodySha: string;
  deviceId: string | null;
}

interface ExistingCreditRow {
  id: string;
  channels: string[];
  ingest_device_id: string | null;
  raw_sha: string | null;
}

async function creditByKey(tx: TenantTx, tenantId: string, key: string): Promise<ExistingCreditRow | null> {
  const rows = (await tx.execute(sql`
    SELECT c.id, c.channels, c.ingest_device_id, r.body_sha256 AS raw_sha
      FROM collection_credits c
      LEFT JOIN collection_raw_messages r ON r.tenant_id = c.tenant_id AND r.id = c.raw_message_id
     WHERE c.tenant_id = ${tenantId} AND c.dedupe_key = ${key}
     FOR UPDATE OF c
  `)) as unknown as ExistingCreditRow[];
  return rows[0] ?? null;
}

/** Up to 5 same-account, same-direction, same-amount credits within ±10 min (§4.7 cross-channel merge). */
async function findMergeTarget(tx: TenantTx, tenantId: string, inc: Incoming): Promise<CreditForEval | null> {
  if (!inc.accountId) return null; // 06 requires both account ids: a no_account credit never cross-merges
  const rows = (await tx.execute(sql`
    SELECT ${CREDIT_EVAL_COLUMNS} FROM collection_credits
     WHERE tenant_id = ${tenantId} AND collection_account_id = ${inc.accountId}
       AND direction = ${inc.direction} AND is_test = ${inc.isTest}
       AND amount = ${inc.amount}::numeric
       AND occurred_at BETWEEN ${inc.occurredAt}::timestamptz - make_interval(mins => ${MATCH_CONSTANTS.MERGE_WINDOW_MIN})
                           AND ${inc.occurredAt}::timestamptz + make_interval(mins => ${MATCH_CONSTANTS.MERGE_WINDOW_MIN})
     ORDER BY abs(extract(epoch FROM occurred_at - ${inc.occurredAt}::timestamptz)), id
     LIMIT 5
     FOR UPDATE
  `)) as unknown as Parameters<typeof creditFromRow>[0][];
  for (const row of rows) {
    const e = creditFromRow(row);
    if (
      shouldMergeCrossChannel(
        {
          accountId: e.accountId,
          amount: e.amount,
          occurredAt: e.occurredAt,
          channels: e.channels,
          operatorReference: e.operatorReference,
          balanceAfter: e.balanceAfter,
          payerPhoneLast4: e.payerPhoneLast4,
        },
        {
          accountId: inc.accountId,
          amount: inc.amount,
          occurredAt: inc.occurredAt,
          channel: inc.channel,
          operatorReference: inc.reference,
          balanceAfter: inc.balanceAfter,
          payerPhoneLast4: inc.payerPhoneLast4,
        },
      )
    ) {
      return e;
    }
  }
  return null;
}

/** Fill NULL fields, upgrade a fallback template, channels ∪=, seen_count++. */
async function mergeInto(tx: TenantTx, tenantId: string, creditId: string, inc: Incoming): Promise<CreditForEval> {
  const rows = (await tx.execute(sql`
    UPDATE collection_credits SET
      operator_reference = COALESCE(operator_reference, ${inc.reference}),
      balance_after = COALESCE(balance_after, ${inc.balanceAfter}::numeric),
      payer_phone_last4 = COALESCE(payer_phone_last4, ${inc.payerPhoneLast4}),
      payer_phone_hmac = COALESCE(payer_phone_hmac, ${inc.payerPhoneHmac}),
      payer_name_masked = COALESCE(payer_name_masked, ${inc.payerNameMasked}),
      payer_name = COALESCE(payer_name, ${inc.payerName}),
      receiving_hint = COALESCE(receiving_hint, ${inc.receivingHint}),
      template_id = CASE WHEN template_id = ${FALLBACK_TEMPLATE_ID} AND ${inc.templateId}::text <> ${FALLBACK_TEMPLATE_ID}
                         THEN ${inc.templateId} ELSE template_id END,
      channels = CASE WHEN ${inc.channel}::text = ANY(channels) THEN channels ELSE array_append(channels, ${inc.channel}::text) END,
      raw_message_id = COALESCE(raw_message_id, ${inc.rawId}::uuid),
      seen_count = seen_count + 1,
      updated_at = now()
     WHERE tenant_id = ${tenantId} AND id = ${creditId}
     RETURNING ${CREDIT_EVAL_COLUMNS}
  `)) as unknown as Parameters<typeof creditFromRow>[0][];
  return creditFromRow(rows[0]!);
}

async function insertCredit(tx: TenantTx, tenantId: string, key: string, inc: Incoming): Promise<CreditForEval | null> {
  const rows = (await tx.execute(sql`
    INSERT INTO collection_credits
      (tenant_id, branch_id, collection_account_id, ingest_device_id, raw_message_id, direction, channels,
       template_id, amount, payer_phone_last4, payer_phone_hmac, payer_name_masked, payer_name, balance_after,
       operator_reference, receiving_hint, sender, sender_kind, occurred_at, device_received_at, state,
       dedupe_key, is_test)
    VALUES (${tenantId}, ${inc.branchId}, ${inc.accountId}, ${inc.deviceId}, ${inc.rawId}, ${inc.direction},
            ARRAY[${inc.channel}]::text[], ${inc.templateId}, ${inc.amount}::numeric, ${inc.payerPhoneLast4},
            ${inc.payerPhoneHmac}, ${inc.payerNameMasked}, ${inc.payerName}, ${inc.balanceAfter}::numeric,
            ${inc.reference}, ${inc.receivingHint}, ${inc.sender}, ${inc.senderKind},
            ${inc.occurredAt}::timestamptz, ${inc.receivedAt}::timestamptz, 'unmatched', ${key}, ${inc.isTest})
    ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
    RETURNING ${CREDIT_EVAL_COLUMNS}
  `)) as unknown as Parameters<typeof creditFromRow>[0][];
  return rows[0] ? creditFromRow(rows[0]) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// One message (§4.7 steps 0–8)
// ─────────────────────────────────────────────────────────────────────────────

export async function ingestOne(
  tx: TenantTx,
  src: IngestSource,
  m: IngestMessage,
  deps: IngestDeps,
  effects: MatchEffects,
): Promise<OneOutcome> {
  const tenantId = src.tenantId;
  const dev = src.device;
  const now = deps.now ? deps.now() : new Date();

  // 0 — channel check (nothing stored).
  if (!src.paste && (!dev || NEVER_DEVICE_CHANNELS.has(m.channel) || !dev.channels.includes(m.channel))) {
    return { status: "dropped", reason: "channel_not_allowed", realCredit: false };
  }

  // 1 — normalise.
  let receivedMs = Date.parse(m.receivedAt);
  if (Number.isNaN(receivedMs) || receivedMs > now.getTime() + FUTURE_SLACK_MS) receivedMs = now.getTime();
  const receivedAt = new Date(receivedMs).toISOString();
  const sender = m.sender && m.sender !== "" ? m.sender.slice(0, 64) : null;
  const senderKind = senderKindOf(m.channel, sender);
  const body = m.body.slice(0, INGEST_BODY_STORED_MAX);
  const title = m.title || null;
  const subtitle = m.subtitle || null;
  const sourceApp = m.sourceApp || null;
  const sha = bodySha256(body);
  const fp = m.fp ?? clientFingerprint({ kind: "manual_paste", sender, body });
  const text = { title, subtitle, body };

  // 2 — raw dedupe.
  const rawId = await insertRaw(tx, {
    tenantId,
    deviceId: dev?.deviceId ?? null,
    channel: m.channel,
    sourceApp,
    sender,
    senderKind,
    fp,
    bodySha: sha,
    receivedAt,
  });
  if (!rawId) return { status: "duplicate", realCredit: false };
  const finish = (status: ParseStatus, templateId: string | null, keepText: boolean) =>
    finishRaw(tx, tenantId, rawId, status, { templateId, text: keepText ? text : null, test: m.test, now });

  // 3 — age / OTP / parse.
  if (now.getTime() - receivedMs > MATCH_CONSTANTS.MAX_AGE_H * HOUR_MS) {
    await finish("too_old", null, true);
    return { status: "dropped", reason: "too_old", realCredit: false };
  }
  if (isOtp(messageText(text))) {
    await finish("otp", null, false);
    return { status: "dropped", reason: "otp", realCredit: false };
  }
  const parsed: ParseResult = parseMessage(
    { channel: m.channel, sender, sourceApp, title, subtitle, body, receivedAt },
    { now, ...(deps.templates ? { templates: deps.templates } : {}) },
  );
  if (parsed.status === "otp") {
    await finish("otp", null, false);
    return { status: "dropped", reason: "otp", realCredit: false };
  }
  if (parsed.status === "too_old" || parsed.status === "not_credit") {
    await finish(parsed.status, parsed.templateId, true);
    return { status: "dropped", reason: parsed.status, realCredit: false };
  }
  if (parsed.status === "unknown_format") {
    await finish("unknown_format", null, true);
    return { status: "accepted", reason: "unknown_format", realCredit: false };
  }
  const f = parsed.fields!;
  const template = lookupTemplate(parsed.templateId, deps);
  const templateId = parsed.templateId ?? FALLBACK_TEMPLATE_ID;
  // A parsed time outside [receivedAt − 48 h, receivedAt + 5 min] is ambiguous (03 §D.3).
  const occMs = Date.parse(f.occurredAt);
  const occurredAt =
    Number.isNaN(occMs) || occMs < receivedMs - MATCH_CONSTANTS.MAX_AGE_H * HOUR_MS || occMs > receivedMs + FUTURE_SLACK_MS
      ? receivedAt
      : new Date(occMs).toISOString();

  // 4 — route.
  const routed = await routeCreditToAccount(tx, src, template, f.receivingHint);

  // 5 — lock (before any FOR UPDATE on credits / collections).
  await lockAccount(tx, tenantId, routed.accountId);

  // 6 — dedupe / merge.
  const fullName = f.payerName && (await storePayerNames(tx, tenantId, routed.branchId)) ? f.payerName : null;
  const inc: Incoming = {
    provider: parsed.provider,
    accountId: routed.accountId,
    branchId: routed.branchId,
    direction: (parsed.direction ?? "credit") as Incoming["direction"],
    templateId,
    amount: f.amount,
    balanceAfter: f.balanceAfter,
    reference: f.reference ? f.reference.toLowerCase() : null,
    receivingHint: f.receivingHint,
    payerPhoneLast4: phoneLast4(f.payerPhone),
    payerPhoneHmac: payerPhoneHmac(f.payerPhone),
    payerNameMasked: maskPayerName(f.payerName),
    payerName: fullName,
    sender,
    senderKind,
    occurredAt,
    receivedAt,
    channel: m.channel,
    isTest: m.test,
    rawId,
    bodySha: sha,
    deviceId: dev?.deviceId ?? null,
  };
  const trust: EvalTrust = {
    channel: m.channel,
    senderKind,
    senderMatched: parsed.senderMatched,
    suspiciousLinks: parsed.suspiciousLinks,
    device: dev ? { live: true, channels: dev.channels } : null,
  };
  const baseKey = creditDedupeKey({
    provider: parsed.provider,
    accountId: routed.accountId,
    receivingHint: f.receivingHint,
    operatorReference: inc.reference,
    amount: f.amount,
    balanceAfter: f.balanceAfter,
    payerPhoneLast4: inc.payerPhoneLast4,
    occurredAt,
  });
  // A setup test never shares a key with a real credit (07 deviation, see spec "As landed").
  const keyFor = (n: number) => {
    const k =
      n === 0
        ? baseKey
        : creditDedupeKey({
            provider: parsed.provider,
            accountId: routed.accountId,
            receivingHint: f.receivingHint,
            operatorReference: inc.reference,
            amount: f.amount,
            balanceAfter: f.balanceAfter,
            payerPhoneLast4: inc.payerPhoneLast4,
            occurredAt,
            collisionIndex: n,
          });
    return m.test ? `t:${k}` : k;
  };

  let key = keyFor(0);
  let mergeTargetId: string | null = null;
  for (const n of [0, 2, 3, 4, 5, 6, 7, 8, 9]) {
    key = keyFor(n);
    const e = await creditByKey(tx, tenantId, key);
    if (!e) break;
    if (src.paste) {
      // A pasted copy of a credit already on file: never modifies it (§6 criterion 17).
      await finish("duplicate", templateId, false);
      return { status: "duplicate", reason: "duplicate", creditId: e.id, realCredit: false };
    }
    const sameChannel = (e.channels ?? []).includes(m.channel);
    const fKey = baseKey.startsWith("f:");
    if (fKey && sameChannel && e.raw_sha !== null && e.raw_sha !== sha) {
      if (n === 9) {
        mergeTargetId = e.id; // ten real credits in one bucket: give up and merge
        break;
      }
      continue; // a second real credit with the same key → suffix #n
    }
    if (sameChannel && dev && e.ingest_device_id === dev.deviceId) {
      await tx.execute(sql`
        UPDATE collection_credits SET seen_count = seen_count + 1, updated_at = now()
         WHERE tenant_id = ${tenantId} AND id = ${e.id}
      `);
      await finish("duplicate", templateId, false);
      return { status: "duplicate", reason: "duplicate", creditId: e.id, realCredit: false };
    }
    mergeTargetId = e.id;
    break;
  }

  let credit: CreditForEval | null = null;
  let merged = false;
  let previous: CreditForEval | null = null;
  if (!mergeTargetId) {
    const target = await findMergeTarget(tx, tenantId, inc);
    if (target) {
      if (src.paste) {
        await finish("duplicate", templateId, false);
        return { status: "duplicate", reason: "duplicate", creditId: target.id, realCredit: false };
      }
      mergeTargetId = target.id;
    }
  }
  if (mergeTargetId) {
    const before = (await tx.execute(sql`
      SELECT ${CREDIT_EVAL_COLUMNS} FROM collection_credits WHERE tenant_id = ${tenantId} AND id = ${mergeTargetId} FOR UPDATE
    `)) as unknown as Parameters<typeof creditFromRow>[0][];
    previous = creditFromRow(before[0]!);
    credit = await mergeInto(tx, tenantId, mergeTargetId, inc);
    merged = true;
  } else {
    credit = await insertCredit(tx, tenantId, key, inc);
    if (!credit) {
      await finish("duplicate", templateId, false);
      return { status: "duplicate", reason: "duplicate", realCredit: false };
    }
  }

  // 7 — evaluate (a merge re-runs only an unmatched / held credit).
  let state: CreditState = credit.state;
  let holdReason: HoldReason | null = credit.holdReason;
  let suggested: string | null = credit.suggestedCollectionId;
  const evaluate = !merged || state === "unmatched" || state === "held";
  if (evaluate) {
    const evalTemplate = lookupTemplate(credit.templateId, deps);
    let balanceOverride: ReturnType<typeof reEvaluationBalance> | undefined;
    if (merged && previous) {
      // Never move the baseline twice; a balance learned only now is checked fresh.
      const acct = credit.accountId ? await loadAccountForEval(tx, tenantId, credit.accountId) : null;
      balanceOverride = previous.balanceAfter == null && credit.balanceAfter != null ? undefined : reEvaluationBalance(previous, evalTemplate, acct);
    }
    const o = await evaluateCredit(
      tx,
      credit,
      {
        template: evalTemplate,
        trust,
        now,
        deviceId: dev?.deviceId ?? null,
        ...(balanceOverride !== undefined ? { balanceOverride } : {}),
        previous: previous
          ? { state: previous.state, holdReason: previous.holdReason, suggestedCollectionId: previous.suggestedCollectionId }
          : null,
        isPaste: src.paste,
      },
      effects,
    );
    state = o.state;
    holdReason = o.holdReason;
    suggested = o.suggestedCollectionId;
  }

  // 8 — raw final write.
  await finish(parsed.status, templateId, true);
  return {
    status: "accepted",
    reason: parsed.status,
    creditId: credit.id,
    state,
    holdReason,
    suggestedCollectionId: suggested,
    realCredit: credit.direction === "credit" && !credit.isTest,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The batch (POST v1/collections/ingest)
// ─────────────────────────────────────────────────────────────────────────────

export async function ingestMessages(
  dev: IngestDeviceContext,
  messages: readonly IngestMessage[],
  deps: IngestDeps = {},
): Promise<{ results: IngestResult[] }> {
  const results: IngestResult[] = [];
  let anyRealCredit = false;
  let anyStored = false;
  const src: IngestSource = { tenantId: dev.tenantId, device: dev, forcedAccountId: null, paste: false };
  for (const m of messages) {
    const effects = newEffects();
    const o = await withTenant(dev.tenantId, async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      return ingestOne(tx, src, m, deps, effects);
    });
    flushMatchEffects(dev.tenantId, effects);
    if (o.reason !== "channel_not_allowed") anyStored = true;
    if (o.realCredit) anyRealCredit = true;
    results.push({ fp: m.fp ?? "", status: o.status, ...(o.reason && o.status !== "duplicate" ? { reason: o.reason } : {}) });
  }
  // 9 — device bookkeeping (13's silent-sweep contract).
  if (anyStored) await touchDeviceAfterBatch(dev, anyRealCredit);
  return { results };
}

// ─────────────────────────────────────────────────────────────────────────────
// Retention (13's rawPurge, §4.10)
// ─────────────────────────────────────────────────────────────────────────────

export async function purgeExpiredRawMessages(
  tenantId: string,
  opts: { limit?: number } = {},
): Promise<{ deleted: number }> {
  const limit = opts.limit ?? 5000;
  return withTenant(tenantId, async (tx) => {
    const rows = (await tx.execute(sql`
      DELETE FROM collection_raw_messages
       WHERE id IN (
         SELECT id FROM collection_raw_messages
          WHERE tenant_id = ${tenantId} AND expires_at < now()
          ORDER BY expires_at
          LIMIT ${limit}
       )
      RETURNING id
    `)) as unknown as { id: string }[];
    return { deleted: rows.length };
  });
}
