// Digital collections — the pure half of the matcher (spec 06 §4.13, part B;
// 03 §C.8). Spec 07 runs these inside its ingest transaction, under the
// per-account advisory lock, with rows it read FOR UPDATE.
//
//   routeCredit         step 2  which receiving account a credit belongs to
//   balanceCheck        step 4  wallet balance continuity
//   rankCandidates      steps 5–6  auto / suggest windows, signals, order
//   decideMatch         step 6  auto | hold | unmatched
//   autoConfirmGate     step 7  every trust gate, security-first priority
//   classifyLateArrival step 10 evidence for a manual confirm, or a rejected match
//
// Money is compared in integer piasters (toPiasters), never in floats.
// Server-authoritative; no IO.

import { toPiasters, fromPiasters } from "./normalize";
import type {
  BalanceCheckInput,
  BalanceCheckResult,
  GateInput,
  GateResult,
  HoldReason,
  IngestChannel,
  LateArrival,
  MatchCollection,
  MatchCredit,
  MatchDecision,
  RankedCandidate,
  ReferenceFormat,
  RouteAccount,
  RouteCreditInput,
  RouteResult,
} from "./types";

export const MATCH_CONSTANTS = {
  AUTO_BEFORE_MIN: 30,
  AUTO_AFTER_MIN: 360,
  SUGGEST_AFTER_H: 72,
  SUGGEST_BEFORE_MIN: 120,
  /** min(EGP 5, 1 %): the allowed over-payment is min(500, floor(collectionPt / 100)) piasters. */
  OVERPAY_SUGGEST_MAX: { pt: 500, pct: 1 },
  MERGE_WINDOW_MIN: 10,
  MAX_AGE_H: 48,
  /** Applied as 2 piasters. */
  BALANCE_EPSILON: 0.02,
  REOPEN_DAYS: 7,
} as const;

const MIN_MS = 60_000;
const BALANCE_EPSILON_PT = Math.round(MATCH_CONSTANTS.BALANCE_EPSILON * 100);

function ms(v: Date | string): number {
  return v instanceof Date ? v.getTime() : Date.parse(v);
}

// ---------------------------------------------------------------------------
// routeCredit (step 2)
// ---------------------------------------------------------------------------

function last4Of(a: RouteAccount): string | null {
  if (a.accountLast4) return a.accountLast4.slice(-4);
  if (a.walletMsisdn) {
    const digits = a.walletMsisdn.replace(/\D/g, "");
    return digits.length >= 4 ? digits.slice(-4) : null;
  }
  return null;
}

/**
 * 1. With a hint: the provider's accounts whose account_last4 or wallet last 4
 *    equals the hint — exactly one → it; several → step 2 runs on those.
 * 2. Otherwise the device-scoped accounts of the provider (prepaid cards only
 *    for a prepaid template) — exactly one → it. Two stricter rules than the
 *    06 text (both only ever produce more `no_account` holds): an account
 *    whose known last 4 CONTRADICTS the hint is never chosen, and a prepaid
 *    card never takes an account-addressed credit.
 * 3. A fallback credit (no template): an explicit, non-empty device scope
 *    holding exactly one account → it.
 * 4. Otherwise `no_account`.
 */
export function routeCredit(input: RouteCreditInput): RouteResult {
  const { template, accounts, deviceAccountIds } = input;
  const hint = input.receivingHint && /^\d{4}$/.test(input.receivingHint) ? input.receivingHint : null;
  const scoped = deviceAccountIds.length > 0 ? accounts.filter((a) => deviceAccountIds.indexOf(a.id) !== -1) : accounts;

  if (template === null) {
    if (deviceAccountIds.length > 0 && scoped.length === 1) return { accountId: scoped[0].id };
    return { accountId: null, reason: "no_account" };
  }

  const ofProvider = accounts.filter((a) => a.provider === template.provider);
  let pool: readonly RouteAccount[] | null = null;
  if (hint !== null) {
    const byHint = ofProvider.filter((a) => last4Of(a) === hint);
    if (byHint.length === 1) return { accountId: byHint[0].id };
    if (byHint.length > 1) pool = byHint;
  }

  const scopedIds = new Set(scoped.map((a) => a.id));
  let candidates = (pool ?? ofProvider).filter((a) => scopedIds.has(a.id));
  if (template.routesToPrepaidCard) candidates = candidates.filter((a) => a.isPrepaidCard);
  else candidates = candidates.filter((a) => !a.isPrepaidCard);
  if (hint !== null) candidates = candidates.filter((a) => last4Of(a) === null || last4Of(a) === hint);
  if (candidates.length === 1) return { accountId: candidates[0].id };
  return { accountId: null, reason: "no_account" };
}

// ---------------------------------------------------------------------------
// balanceCheck (step 4)
// ---------------------------------------------------------------------------

/**
 * Wallet balance continuity [wallets.md §8]. A baseline only ever comes from
 * a `pass` or a human decision (spec 07 applies both), so "a first fake SMS
 * cannot plant a starting balance".
 */
export function balanceCheck(input: BalanceCheckInput): BalanceCheckResult {
  const { enabled, template, direction, amount, balanceAfter, baseline, baselineAt, chainBrokenAt } = input;
  if (!enabled || !template || !template.hasBalance || balanceAfter == null) {
    return { result: "not_applicable", newBaseline: null };
  }
  if (direction === "debit") return { result: "breaks_chain", newBaseline: null };
  if (baseline == null) return { result: "no_baseline", newBaseline: null };
  if (chainBrokenAt != null && (baselineAt == null || ms(chainBrokenAt) > ms(baselineAt))) {
    return { result: "no_baseline", newBaseline: null };
  }
  const after = toPiasters(balanceAfter);
  const expected = toPiasters(baseline) + toPiasters(amount);
  if (Math.abs(after - expected) <= BALANCE_EPSILON_PT) return { result: "pass", newBaseline: fromPiasters(after) };
  return { result: "mismatch", newBaseline: null };
}

// ---------------------------------------------------------------------------
// rankCandidates (steps 5–6)
// ---------------------------------------------------------------------------

/** Is a typed payer reference comparable with the operator's reference format (I1/I2)? */
function comparable(typed: string, format: ReferenceFormat): boolean {
  if (format === "digits12" || format === "digits10") return /^\d+$/.test(typed);
  if (format === "hex8") return /^[0-9a-f]{4,8}$/.test(typed);
  return false;
}

/**
 * Every pending collection that fits the auto or the suggest window, scored
 * and ordered: non-conflicting first, score desc, |deltaMin| asc, rungAt asc,
 * id asc. A conflicting strong signal (both values present and different)
 * removes the candidate from `auto` but keeps it as a flagged suggestion.
 */
export function rankCandidates(credit: MatchCredit, collections: readonly MatchCollection[]): RankedCandidate[] {
  const creditPt = toPiasters(credit.amount);
  const occurred = ms(credit.occurredAt);
  const opRef = credit.operatorReference ? credit.operatorReference.toLowerCase() : null;
  const out: Array<RankedCandidate & { rungMs: number }> = [];

  for (const c of collections) {
    if (c.status !== "pending") continue;
    const collPt = toPiasters(c.amount);
    const rung = ms(c.rungAt);
    const deltaMin = (occurred - rung) / MIN_MS;
    const overpayPt = creditPt - collPt;
    const sameAccount = credit.accountId !== null && c.accountId === credit.accountId;

    const inAuto =
      sameAccount &&
      overpayPt === 0 &&
      deltaMin >= -MATCH_CONSTANTS.AUTO_BEFORE_MIN &&
      deltaMin <= MATCH_CONSTANTS.AUTO_AFTER_MIN;
    const maxOverpay = Math.min(MATCH_CONSTANTS.OVERPAY_SUGGEST_MAX.pt, Math.floor((collPt * MATCH_CONSTANTS.OVERPAY_SUGGEST_MAX.pct) / 100));
    const inSuggest =
      (sameAccount || (c.accountId === null && credit.rail !== null && c.method === credit.rail)) &&
      deltaMin >= -MATCH_CONSTANTS.SUGGEST_BEFORE_MIN &&
      deltaMin <= MATCH_CONSTANTS.SUGGEST_AFTER_H * 60 &&
      overpayPt >= 0 &&
      overpayPt <= maxOverpay;
    if (!inAuto && !inSuggest) continue;

    const signals: ("reference" | "phone")[] = [];
    let score = 0;
    let conflict = false;
    const typed = c.payerReference ? c.payerReference.trim().toLowerCase() : null;
    if (typed && typed.length >= 4 && opRef && comparable(typed, credit.operatorReferenceFormat)) {
      if (opRef.endsWith(typed)) {
        signals.push("reference");
        score += 100;
      } else conflict = true;
    }
    if (c.payerPhoneLast4 && credit.payerPhoneLast4) {
      if (c.payerPhoneLast4 === credit.payerPhoneLast4) {
        signals.push("phone");
        score += 50;
      } else conflict = true;
    }

    out.push({
      collectionId: c.id,
      window: inAuto && !conflict ? "auto" : "suggest",
      score,
      signals,
      conflict,
      deltaMin,
      overpayPt,
      rungMs: rung,
    });
  }

  out.sort(
    (a, b) =>
      Number(a.conflict) - Number(b.conflict) ||
      b.score - a.score ||
      Math.abs(a.deltaMin) - Math.abs(b.deltaMin) ||
      a.rungMs - b.rungMs ||
      (a.collectionId < b.collectionId ? -1 : a.collectionId > b.collectionId ? 1 : 0),
  );
  return out.map(({ rungMs: _rungMs, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// decideMatch (step 6)
// ---------------------------------------------------------------------------

/**
 * Picks; the inbox lists every candidate of `ranked`.
 * - exactly one auto → auto; ≥ 2 auto with exactly one score > 0 → that one;
 *   otherwise hold `ambiguous` suggesting the first auto (the closest);
 * - no auto: an exact-amount suggestion → unmatched + that suggestion; only
 *   over-payments → hold `amount_mismatch`; nothing → unmatched.
 */
export function decideMatch(ranked: readonly RankedCandidate[]): MatchDecision {
  const autos = ranked.filter((r) => r.window === "auto");
  if (autos.length === 1) return { kind: "auto", collectionId: autos[0].collectionId };
  if (autos.length >= 2) {
    const strong = autos.filter((r) => r.score > 0);
    if (strong.length === 1) return { kind: "auto", collectionId: strong[0].collectionId };
    return { kind: "hold", reason: "ambiguous", suggestedCollectionId: autos[0].collectionId };
  }
  if (ranked.length === 0) return { kind: "unmatched", suggestedCollectionId: null };
  const exact = ranked.find((r) => r.overpayPt === 0);
  if (exact) return { kind: "unmatched", suggestedCollectionId: exact.collectionId };
  return { kind: "hold", reason: "amount_mismatch", suggestedCollectionId: ranked[0].collectionId };
}

// ---------------------------------------------------------------------------
// autoConfirmGate (step 7)
// ---------------------------------------------------------------------------

const SMS_CHANNELS: readonly IngestChannel[] = ["ios_sms", "android_sms"];
const NOTIFICATION_CHANNELS: readonly IngestChannel[] = ["ios_notification", "android_notification"];

/**
 * Every check is evaluated; `reason` = the first failing one in this
 * security-first priority (06 ARCH CR 3): test · manual_source ·
 * suspicious_link · untrusted_source · too_old · balance_mismatch ·
 * above_review_limit · unverified_format · no_balance_baseline ·
 * auto_confirm_off. `pass` only when none fails.
 */
export function autoConfirmGate(input: GateInput): GateResult {
  const reasons: HoldReason[] = [];
  const t = input.template;

  if (input.isTest) reasons.push("test");
  if (input.channel === "manual_paste") reasons.push("manual_source");
  if (input.suspiciousLinks.length > 0) reasons.push("suspicious_link");

  const trustedSource =
    (SMS_CHANNELS.indexOf(input.channel) !== -1 && input.senderKind === "alphanumeric" && input.senderMatched) ||
    (NOTIFICATION_CHANNELS.indexOf(input.channel) !== -1 && input.senderKind === "app" && input.senderMatched);
  if (!input.device || !input.device.live || input.device.channels.indexOf(input.channel) === -1 || !trustedSource) {
    reasons.push("untrusted_source");
  }

  const occurred = ms(input.occurredAt);
  if (Number.isNaN(occurred) || input.now.getTime() - occurred > MATCH_CONSTANTS.MAX_AGE_H * 3_600_000) {
    reasons.push("too_old");
  }

  if (t && t.autoConfirm === "balance" && input.balance === "mismatch") reasons.push("balance_mismatch");

  let overLimit = true;
  try {
    overLimit = toPiasters(input.amount) > toPiasters(input.account.reviewThreshold);
  } catch {
    overLimit = true; // fail closed on an unreadable amount or threshold
  }
  if (overLimit) reasons.push("above_review_limit");

  if (
    !t ||
    t.status !== "pilot_verified" ||
    t.autoConfirm === "never" ||
    (t.autoConfirm === "reference" && input.reference == null)
  ) {
    reasons.push("unverified_format");
  }

  if (
    t &&
    t.autoConfirm === "balance" &&
    (input.balance === "no_baseline" || input.balance === "breaks_chain" || input.balance === "not_applicable")
  ) {
    reasons.push("no_balance_baseline");
  }

  if (!input.autoConfirmFeature || !input.account.autoConfirmEnabled) reasons.push("auto_confirm_off");

  return { pass: reasons.length === 0, reason: reasons.length > 0 ? reasons[0] : null, reasons };
}

// ---------------------------------------------------------------------------
// classifyLateArrival (step 10)
// ---------------------------------------------------------------------------

/**
 * Called when rankCandidates yields no auto candidate. Same account, same
 * amount and the auto window are required. A manually `confirmed` collection
 * with no credit yet → evidence (the closest); else a `rejected` one →
 * `matches_rejected` (the closest); else none.
 */
export function classifyLateArrival(credit: MatchCredit, collections: readonly MatchCollection[]): LateArrival {
  if (credit.accountId === null) return { kind: "none" };
  const creditPt = toPiasters(credit.amount);
  const occurred = ms(credit.occurredAt);
  const fits = (c: MatchCollection) => {
    if (c.accountId !== credit.accountId || toPiasters(c.amount) !== creditPt) return false;
    const deltaMin = (occurred - ms(c.rungAt)) / MIN_MS;
    return deltaMin >= -MATCH_CONSTANTS.AUTO_BEFORE_MIN && deltaMin <= MATCH_CONSTANTS.AUTO_AFTER_MIN;
  };
  const closest = (list: MatchCollection[]) =>
    list.sort(
      (a, b) =>
        Math.abs(occurred - ms(a.rungAt)) - Math.abs(occurred - ms(b.rungAt)) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )[0];
  const evidence = collections.filter((c) => c.status === "confirmed" && c.matchedCreditId == null && fits(c));
  if (evidence.length > 0) return { kind: "evidence", collectionId: closest(evidence).id };
  const rejected = collections.filter((c) => c.status === "rejected" && fits(c));
  if (rejected.length > 0) return { kind: "matches_rejected", collectionId: closest(rejected).id };
  return { kind: "none" };
}
