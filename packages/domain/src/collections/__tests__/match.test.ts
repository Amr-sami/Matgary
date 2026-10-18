// Run: npm test -w @matgary/domain
// Spec 06 §7 match.test.ts + acceptance 11 (the pure half of 03 §C.8).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MATCH_CONSTANTS,
  autoConfirmGate,
  balanceCheck,
  classifyLateArrival,
  decideMatch,
  rankCandidates,
  routeCredit,
} from "../match";
import { CIB_SMS_CREDIT_V1 } from "../templates/cib";
import { NBE_SMS_CREDIT_V1, NBE_SMS_PREPAID_CREDIT_V1 } from "../templates/nbe";
import { ORANGE_CASH_SMS_CASH_IN_V1 } from "../templates/orange_cash";
import { VODAFONE_CASH_SMS_CREDIT_V1, VODAFONE_CASH_SMS_DEBIT_V1 } from "../templates/vodafone_cash";
import type {
  CollectionTemplate,
  GateInput,
  HoldReason,
  MatchCollection,
  MatchCredit,
  RouteAccount,
} from "../types";

const T0 = Date.parse("2026-05-06T12:00:00Z");
const iso = (minFromT0: number) => new Date(T0 + minFromT0 * 60_000).toISOString();

const credit = (over: Partial<MatchCredit> = {}): MatchCredit => ({
  accountId: "acc-1",
  rail: "instapay",
  amount: "100.00",
  occurredAt: iso(0),
  operatorReference: null,
  operatorReferenceFormat: "hex8",
  payerPhoneLast4: null,
  ...over,
});
const coll = (id: string, over: Partial<MatchCollection> = {}): MatchCollection => ({
  id,
  status: "pending",
  accountId: "acc-1",
  method: "instapay",
  amount: "100.00",
  rungAt: iso(0),
  payerReference: null,
  payerPhoneLast4: null,
  matchedCreditId: null,
  ...over,
});
// rungAt such that occurred − rung = d minutes (occurred is T0).
const rungFor = (d: number) => iso(-d);

test("MATCH_CONSTANTS are 03 §C.8's values", () => {
  assert.deepEqual(MATCH_CONSTANTS, {
    AUTO_BEFORE_MIN: 30,
    AUTO_AFTER_MIN: 360,
    SUGGEST_AFTER_H: 72,
    SUGGEST_BEFORE_MIN: 120,
    OVERPAY_SUGGEST_MAX: { pt: 500, pct: 1 },
    MERGE_WINDOW_MIN: 10,
    MAX_AGE_H: 48,
    BALANCE_EPSILON: 0.02,
    REOPEN_DAYS: 7,
  });
});

// ---------------------------------------------------------------- windows

test("windows: −30 min auto / −31 suggest; +360 auto / +361 suggest; +72 h suggest / +72 h 1 min out; −120 / −121", () => {
  const w = (d: number) => rankCandidates(credit(), [coll("c", { rungAt: rungFor(d) })])[0]?.window ?? "out";
  assert.equal(w(-30), "auto");
  assert.equal(w(-31), "suggest");
  assert.equal(w(360), "auto");
  assert.equal(w(361), "suggest");
  assert.equal(w(72 * 60), "suggest");
  assert.equal(w(72 * 60 + 1), "out");
  assert.equal(w(-120), "suggest");
  assert.equal(w(-121), "out");
  assert.equal(rankCandidates(credit(), [coll("c", { rungAt: rungFor(15) })])[0].deltaMin, 15);
});

test("over-payment: EGP 1.00 on EGP 100 is suggested, EGP 1.01 is not; any under-payment is out; the cap is EGP 5", () => {
  const r = (amount: string, collAmount = "100.00") => rankCandidates(credit({ amount }), [coll("c", { amount: collAmount })]);
  assert.equal(r("101.00")[0].window, "suggest");
  assert.equal(r("101.00")[0].overpayPt, 100);
  assert.deepEqual(r("101.01"), []);
  assert.deepEqual(r("99.99"), []);
  assert.equal(r("10005.00", "10000.00")[0].window, "suggest", "min(EGP 5, 1 %) = EGP 5 on EGP 10,000");
  assert.deepEqual(r("10005.01", "10000.00"), []);
});

test("an account-null collection with the credit's rail gives a suggestion only; another rail nothing", () => {
  const r = rankCandidates(credit(), [coll("c", { accountId: null })]);
  assert.equal(r.length, 1);
  assert.equal(r[0].window, "suggest");
  assert.deepEqual(rankCandidates(credit(), [coll("c", { accountId: null, method: "wallet" })]), []);
  assert.deepEqual(rankCandidates(credit(), [coll("c", { accountId: "acc-2" })]), [], "another account");
  assert.deepEqual(rankCandidates(credit({ accountId: null }), [coll("c")]), [], "an unrouted credit never matches an account's sale");
});

test("only pending collections are candidates", () => {
  for (const status of ["confirmed", "auto_confirmed", "rejected", "void"] as const) {
    assert.deepEqual(rankCandidates(credit(), [coll("c", { status })]), [], status);
  }
});

// ---------------------------------------------------------------- signals

test("signals: a reference suffix +100, a phone +50; both 150", () => {
  const ref = rankCandidates(credit({ operatorReference: "FF961E35" }), [coll("c", { payerReference: "1e35" })])[0];
  assert.deepEqual([ref.score, ref.signals, ref.conflict, ref.window], [100, ["reference"], false, "auto"]);
  const phone = rankCandidates(credit({ payerPhoneLast4: "7705" }), [coll("c", { payerPhoneLast4: "7705" })])[0];
  assert.deepEqual([phone.score, phone.signals], [50, ["phone"]]);
  const both = rankCandidates(credit({ operatorReference: "ff961e35", payerPhoneLast4: "7705" }), [
    coll("c", { payerReference: "FF961E35", payerPhoneLast4: "7705" }),
  ])[0];
  assert.equal(both.score, 150);
});

test("signals: a conflicting reference moves the candidate to suggest with conflict, ranked last", () => {
  const r = rankCandidates(credit({ operatorReference: "ff961e35" }), [
    coll("a-conflict", { payerReference: "9999", rungAt: rungFor(1) }),
    coll("b-plain", { rungAt: rungFor(100) }),
  ]);
  assert.deepEqual(
    r.map((c) => [c.collectionId, c.window, c.conflict]),
    [
      ["b-plain", "auto", false],
      ["a-conflict", "suggest", true],
    ],
  );
  const phone = rankCandidates(credit({ payerPhoneLast4: "1111" }), [coll("c", { payerPhoneLast4: "2222" })])[0];
  assert.deepEqual([phone.window, phone.conflict], ["suggest", true]);
});

test("signals: a reference is compared only when comparable with the format (hex vs digits12 → no signal)", () => {
  const nbe = (typed: string) =>
    rankCandidates(credit({ operatorReference: "125073164743", operatorReferenceFormat: "digits12" }), [
      coll("c", { payerReference: typed }),
    ])[0];
  assert.deepEqual([nbe("4743").score, nbe("4743").conflict], [100, false]);
  assert.deepEqual([nbe("ab12").score, nbe("ab12").conflict, nbe("ab12").window], [0, false, "auto"], "hex typed vs digits12");
  assert.deepEqual([nbe("9999").conflict, nbe("9999").window], [true, "suggest"]);
  assert.deepEqual([nbe("123").score, nbe("123").conflict], [0, false], "fewer than 4 characters");
  const hex = rankCandidates(credit({ operatorReference: "ff961e35", operatorReferenceFormat: "hex8" }), [
    coll("c", { payerReference: "zz12" }),
  ])[0];
  assert.deepEqual([hex.score, hex.conflict], [0, false], "not hex");
  const none = rankCandidates(credit({ operatorReference: null, operatorReferenceFormat: "none" }), [
    coll("c", { payerReference: "1234" }),
  ])[0];
  assert.deepEqual([none.score, none.conflict], [0, false]);
});

test("ranking order: non-conflicting, score desc, |delta| asc, rungAt asc, id asc", () => {
  const r = rankCandidates(credit({ payerPhoneLast4: "7705" }), [
    coll("e", { rungAt: rungFor(10) }),
    coll("d", { rungAt: rungFor(-10) }),
    coll("c", { rungAt: rungFor(5) }),
    coll("b", { rungAt: rungFor(5), payerPhoneLast4: "7705" }),
    coll("a", { rungAt: rungFor(5), payerPhoneLast4: "0000" }),
    coll("f", { rungAt: rungFor(10) }),
  ]);
  assert.deepEqual(
    r.map((c) => c.collectionId),
    // |10| ties: e and f rang 10 min BEFORE the credit (earlier rungAt) and d 10 min after; e < f by id.
    ["b", "c", "e", "f", "d", "a"],
  );
});

// ---------------------------------------------------------------- decideMatch

test("decideMatch: one auto; two auto with one strong; two auto with none strong → ambiguous + closest", () => {
  assert.deepEqual(decideMatch(rankCandidates(credit(), [coll("x")])), { kind: "auto", collectionId: "x" });
  const strong = rankCandidates(credit({ payerPhoneLast4: "7705" }), [
    coll("near", { rungAt: rungFor(1) }),
    coll("phone", { rungAt: rungFor(200), payerPhoneLast4: "7705" }),
  ]);
  assert.deepEqual(decideMatch(strong), { kind: "auto", collectionId: "phone" });
  const ambiguous = rankCandidates(credit(), [coll("far", { rungAt: rungFor(200) }), coll("near", { rungAt: rungFor(-5) })]);
  assert.deepEqual(decideMatch(ambiguous), { kind: "hold", reason: "ambiguous", suggestedCollectionId: "near" });
  const twoStrong = rankCandidates(credit({ payerPhoneLast4: "7705" }), [
    coll("p1", { rungAt: rungFor(30), payerPhoneLast4: "7705" }),
    coll("p2", { rungAt: rungFor(3), payerPhoneLast4: "7705" }),
  ]);
  assert.deepEqual(decideMatch(twoStrong), { kind: "hold", reason: "ambiguous", suggestedCollectionId: "p2" });
});

test("decideMatch: a suggestion only → unmatched + suggestion; over-payment only → amount_mismatch; none", () => {
  const suggestOnly = rankCandidates(credit(), [coll("s", { rungAt: rungFor(600) })]);
  assert.deepEqual(decideMatch(suggestOnly), { kind: "unmatched", suggestedCollectionId: "s" });
  const over = rankCandidates(credit({ amount: "100.50" }), [coll("o")]);
  assert.deepEqual(decideMatch(over), { kind: "hold", reason: "amount_mismatch", suggestedCollectionId: "o" });
  assert.deepEqual(decideMatch([]), { kind: "unmatched", suggestedCollectionId: null });
  // A conflicting exact candidate never auto-confirms; it is only suggested.
  const conflict = rankCandidates(credit({ payerPhoneLast4: "1111" }), [coll("k", { payerPhoneLast4: "2222" })]);
  assert.deepEqual(decideMatch(conflict), { kind: "unmatched", suggestedCollectionId: "k" });
});

// ---------------------------------------------------------------- autoConfirmGate

const VERIFIED_REF: CollectionTemplate = { ...NBE_SMS_CREDIT_V1, status: "pilot_verified" };
const VERIFIED_BAL: CollectionTemplate = { ...VODAFONE_CASH_SMS_CREDIT_V1, status: "pilot_verified" };
const NOW = new Date("2026-05-04T10:00:00Z");

const gate = (over: Partial<GateInput> = {}): GateInput => ({
  autoConfirmFeature: true,
  account: { autoConfirmEnabled: true, reviewThreshold: "5000" },
  template: VERIFIED_REF,
  channel: "android_sms",
  senderKind: "alphanumeric",
  senderMatched: true,
  device: { live: true, channels: ["android_sms", "android_notification"] },
  amount: "5000.00",
  occurredAt: "2026-05-04T09:25:00Z",
  reference: "125073164743",
  suspiciousLinks: [],
  isTest: false,
  balance: "not_applicable",
  now: NOW,
  ...over,
});
const balanceGate = (over: Partial<GateInput> = {}) =>
  gate({ template: VERIFIED_BAL, reference: "022177777777", balance: "pass", ...over });

test("autoConfirmGate passes only when all ten checks pass (reference and balance templates)", () => {
  assert.deepEqual(autoConfirmGate(gate()), { pass: true, reason: null, reasons: [] });
  assert.deepEqual(autoConfirmGate(balanceGate()), { pass: true, reason: null, reasons: [] });
  assert.equal(autoConfirmGate(gate({ channel: "android_notification", senderKind: "app" })).pass, true);
});

test("autoConfirmGate: each of the ten reasons alone", () => {
  const cases: Array<[HoldReason, GateInput]> = [
    ["test", gate({ isTest: true })],
    ["suspicious_link", gate({ suspiciousLinks: ["http://vf-eg.co/x"] })],
    ["untrusted_source", gate({ senderMatched: false })],
    ["too_old", gate({ occurredAt: "2026-05-02T09:59:00Z" })],
    ["balance_mismatch", balanceGate({ balance: "mismatch" })],
    ["above_review_limit", gate({ amount: "5000.01" })],
    ["unverified_format", gate({ template: NBE_SMS_CREDIT_V1 })],
    ["no_balance_baseline", balanceGate({ balance: "no_baseline" })],
    ["auto_confirm_off", gate({ autoConfirmFeature: false })],
  ];
  for (const [reason, input] of cases) {
    assert.deepEqual(autoConfirmGate(input), { pass: false, reason, reasons: [reason] }, reason);
  }
  // manual_source: a paste is also never a trusted source, so two checks fail.
  const paste = autoConfirmGate(gate({ channel: "manual_paste", device: { live: true, channels: ["manual_paste"] } }));
  assert.deepEqual([paste.pass, paste.reason, paste.reasons], [false, "manual_source", ["manual_source", "untrusted_source"]]);
});

test("autoConfirmGate: every variant of untrusted_source, unverified_format and auto_confirm_off", () => {
  const only = (input: GateInput) => autoConfirmGate(input).reasons;
  assert.deepEqual(only(gate({ device: null })), ["untrusted_source"]);
  assert.deepEqual(only(gate({ device: { live: false, channels: ["android_sms"] } })), ["untrusted_source"]);
  assert.deepEqual(only(gate({ device: { live: true, channels: ["android_notification"] } })), ["untrusted_source"]);
  assert.deepEqual(only(gate({ senderKind: "numeric" })), ["untrusted_source"]);
  assert.deepEqual(only(gate({ channel: "android_notification", senderKind: "alphanumeric" })), ["untrusted_source"]);
  assert.deepEqual(only(gate({ template: null })), ["unverified_format"]);
  assert.deepEqual(only(gate({ template: { ...VERIFIED_REF, autoConfirm: "never" } })), ["unverified_format"]);
  assert.deepEqual(only(gate({ reference: null })), ["unverified_format"]);
  assert.deepEqual(only(gate({ account: { autoConfirmEnabled: false, reviewThreshold: "5000" } })), ["auto_confirm_off"]);
  assert.deepEqual(only(gate({ account: { autoConfirmEnabled: true, reviewThreshold: "abc" } })), ["above_review_limit"], "fails closed");
  assert.deepEqual(only(gate({ occurredAt: "2026-05-02T10:00:00Z" })), [], "exactly 48 h is not too old");
});

test("autoConfirmGate: the security-first priority with several failing; test is always first", () => {
  const all = autoConfirmGate(
    gate({
      isTest: true,
      channel: "manual_paste",
      suspiciousLinks: ["x.co"],
      occurredAt: "2026-04-01T00:00:00Z",
      amount: "999999",
      template: { ...VODAFONE_CASH_SMS_CREDIT_V1 },
      balance: "mismatch",
      autoConfirmFeature: false,
    }),
  );
  assert.deepEqual(all.reasons, [
    "test",
    "manual_source",
    "suspicious_link",
    "untrusted_source",
    "too_old",
    "balance_mismatch",
    "above_review_limit",
    "unverified_format",
    "auto_confirm_off",
  ]);
  assert.equal(all.reason, "test");
  // At M2 (every template published_sample) a held credit reads unverified_format, never auto_confirm_off.
  const m2 = autoConfirmGate(gate({ template: NBE_SMS_CREDIT_V1, autoConfirmFeature: false }));
  assert.equal(m2.reason, "unverified_format");
  // "possible fake" before "auto-confirm is off".
  assert.equal(autoConfirmGate(gate({ suspiciousLinks: ["x.co"], autoConfirmFeature: false })).reason, "suspicious_link");
});

test("D06-c: a balance template with the balance check disabled never auto-confirms (no_balance_baseline)", () => {
  const disabled = balanceCheck({
    enabled: false,
    template: VERIFIED_BAL,
    direction: "credit",
    amount: "2700.00",
    balanceAfter: "2724.51",
    baseline: "24.51",
    baselineAt: "2026-07-27T10:00:00Z",
    chainBrokenAt: null,
  });
  assert.equal(disabled.result, "not_applicable");
  const g = autoConfirmGate(balanceGate({ balance: disabled.result }));
  assert.deepEqual([g.pass, g.reason], [false, "no_balance_baseline"]);
  assert.equal(autoConfirmGate(balanceGate({ balance: "breaks_chain" })).reason, "no_balance_baseline");
});

// ---------------------------------------------------------------- balanceCheck

test("balanceCheck: pass at ±0.02, mismatch at 0.03, no baseline, chain broken after the baseline, debit, cash_in", () => {
  const base = {
    enabled: true,
    template: VODAFONE_CASH_SMS_CREDIT_V1,
    direction: "credit" as const,
    amount: "2700.00",
    balanceAfter: "2724.51",
    baseline: "24.51",
    baselineAt: "2026-07-27T10:00:00Z",
    chainBrokenAt: null,
  };
  assert.deepEqual(balanceCheck(base), { result: "pass", newBaseline: "2724.51" });
  assert.equal(balanceCheck({ ...base, balanceAfter: "2724.53" }).result, "pass");
  assert.equal(balanceCheck({ ...base, balanceAfter: "2724.49" }).result, "pass");
  assert.equal(balanceCheck({ ...base, balanceAfter: "2724.54" }).result, "mismatch");
  assert.equal(balanceCheck({ ...base, balanceAfter: "2724.48" }).result, "mismatch");
  assert.deepEqual(balanceCheck({ ...base, baseline: null }), { result: "no_baseline", newBaseline: null });
  assert.equal(balanceCheck({ ...base, chainBrokenAt: "2026-07-27T11:00:00Z" }).result, "no_baseline");
  assert.equal(balanceCheck({ ...base, chainBrokenAt: "2026-07-27T09:00:00Z" }).result, "pass", "broken before the baseline");
  assert.deepEqual(
    balanceCheck({ ...base, template: VODAFONE_CASH_SMS_DEBIT_V1, direction: "debit", amount: "500.00", balanceAfter: "10.00" }),
    { result: "breaks_chain", newBaseline: null },
  );
  assert.deepEqual(
    balanceCheck({ ...base, template: ORANGE_CASH_SMS_CASH_IN_V1, direction: "cash_in", amount: "6.43", balanceAfter: "6.43", baseline: "0.00" }),
    { result: "pass", newBaseline: "6.43" },
    "an agent deposit extends the chain (OC-3)",
  );
  assert.equal(balanceCheck({ ...base, template: CIB_SMS_CREDIT_V1 }).result, "not_applicable", "no balance in the template");
  assert.equal(balanceCheck({ ...base, balanceAfter: null }).result, "not_applicable");
  assert.equal(balanceCheck({ ...base, template: null }).result, "not_applicable");
});

// ---------------------------------------------------------------- routeCredit

const acct = (id: string, over: Partial<RouteAccount> = {}): RouteAccount => ({
  id,
  provider: "nbe",
  rail: "instapay",
  accountLast4: null,
  walletMsisdn: null,
  isPrepaidCard: false,
  ...over,
});

test("routeCredit: a VF hint from the receiving number picks that wallet among two", () => {
  const accounts = [
    acct("vf-a", { provider: "vodafone_cash", rail: "wallet", walletMsisdn: "+201007777765" }),
    acct("vf-b", { provider: "vodafone_cash", rail: "wallet", walletMsisdn: "+201001111111" }),
  ];
  assert.deepEqual(routeCredit({ template: VODAFONE_CASH_SMS_CREDIT_V1, receivingHint: "7765", accounts, deviceAccountIds: [] }), {
    accountId: "vf-a",
  });
});

test("routeCredit: NBE prepaid with one card routes; with two it does not", () => {
  const one = [acct("nbe-acc", { accountLast4: "0150" }), acct("card-1", { isPrepaidCard: true })];
  assert.deepEqual(routeCredit({ template: NBE_SMS_PREPAID_CREDIT_V1, receivingHint: null, accounts: one, deviceAccountIds: [] }), {
    accountId: "card-1",
  });
  const two = [...one, acct("card-2", { isPrepaidCard: true })];
  assert.deepEqual(routeCredit({ template: NBE_SMS_PREPAID_CREDIT_V1, receivingHint: null, accounts: two, deviceAccountIds: [] }), {
    accountId: null,
    reason: "no_account",
  });
});

test("routeCredit: two same-provider accounts with no hint → no_account; a device scope narrows to one", () => {
  const accounts = [acct("n1"), acct("n2"), acct("c1", { provider: "cib" })];
  assert.deepEqual(routeCredit({ template: NBE_SMS_CREDIT_V1, receivingHint: null, accounts, deviceAccountIds: [] }), {
    accountId: null,
    reason: "no_account",
  });
  assert.deepEqual(routeCredit({ template: NBE_SMS_CREDIT_V1, receivingHint: null, accounts, deviceAccountIds: ["n2", "c1"] }), {
    accountId: "n2",
  });
  assert.deepEqual(routeCredit({ template: CIB_SMS_CREDIT_V1, receivingHint: null, accounts, deviceAccountIds: [] }), {
    accountId: "c1",
  });
});

test("routeCredit: an exact hint wins over the device scope; several hint matches restrict step 2", () => {
  const accounts = [acct("a", { accountLast4: "0150" }), acct("b", { accountLast4: "9999" })];
  assert.deepEqual(routeCredit({ template: NBE_SMS_CREDIT_V1, receivingHint: "0150", accounts, deviceAccountIds: ["b"] }), {
    accountId: "a",
  });
  const twins = [acct("t1", { accountLast4: "0150" }), acct("t2", { accountLast4: "0150" }), acct("o", { accountLast4: "1111" })];
  assert.deepEqual(routeCredit({ template: NBE_SMS_CREDIT_V1, receivingHint: "0150", accounts: twins, deviceAccountIds: [] }), {
    accountId: null,
    reason: "no_account",
  });
  assert.deepEqual(routeCredit({ template: NBE_SMS_CREDIT_V1, receivingHint: "0150", accounts: twins, deviceAccountIds: ["t2", "o"] }), {
    accountId: "t2",
  });
});

test("routeCredit: a contradicting hint never routes to the only account; a prepaid card never takes an account credit", () => {
  // The owner's unregistered personal NBE account ends 9999; the shop registered 0150.
  assert.deepEqual(
    routeCredit({ template: NBE_SMS_CREDIT_V1, receivingHint: "9999", accounts: [acct("shop", { accountLast4: "0150" })], deviceAccountIds: [] }),
    { accountId: null, reason: "no_account" },
  );
  // An account with no last 4 recorded still takes a hinted credit when it is the only one.
  assert.deepEqual(
    routeCredit({ template: NBE_SMS_CREDIT_V1, receivingHint: "9999", accounts: [acct("shop")], deviceAccountIds: [] }),
    { accountId: "shop" },
  );
  assert.deepEqual(
    routeCredit({ template: NBE_SMS_CREDIT_V1, receivingHint: "0150", accounts: [acct("card", { isPrepaidCard: true })], deviceAccountIds: [] }),
    { accountId: null, reason: "no_account" },
  );
});

test("routeCredit: a fallback credit routes only to the single account of an explicit device scope", () => {
  const accounts = [acct("a"), acct("b", { provider: "vodafone_cash", rail: "wallet" })];
  assert.deepEqual(routeCredit({ template: null, receivingHint: null, accounts, deviceAccountIds: ["b"] }), { accountId: "b" });
  assert.deepEqual(routeCredit({ template: null, receivingHint: null, accounts, deviceAccountIds: [] }), {
    accountId: null,
    reason: "no_account",
  });
  assert.deepEqual(routeCredit({ template: null, receivingHint: null, accounts: [acct("a")], deviceAccountIds: [] }), {
    accountId: null,
    reason: "no_account",
  });
  assert.deepEqual(routeCredit({ template: null, receivingHint: null, accounts, deviceAccountIds: ["gone"] }), {
    accountId: null,
    reason: "no_account",
  });
});

// ---------------------------------------------------------------- classifyLateArrival

test("classifyLateArrival: evidence for a manual confirm, matches_rejected, none", () => {
  const c = credit();
  assert.deepEqual(
    classifyLateArrival(c, [
      coll("far", { status: "confirmed", rungAt: rungFor(300) }),
      coll("near", { status: "confirmed", rungAt: rungFor(10) }),
      coll("rej", { status: "rejected" }),
    ]),
    { kind: "evidence", collectionId: "near" },
  );
  assert.deepEqual(classifyLateArrival(c, [coll("has-credit", { status: "confirmed", matchedCreditId: "cr-9" }), coll("rej", { status: "rejected" })]), {
    kind: "matches_rejected",
    collectionId: "rej",
  });
  assert.deepEqual(classifyLateArrival(c, [coll("rej", { status: "rejected", amount: "100.01" })]), { kind: "none" }, "amount");
  assert.deepEqual(classifyLateArrival(c, [coll("rej", { status: "rejected", rungAt: rungFor(361) })]), { kind: "none" }, "window");
  assert.deepEqual(classifyLateArrival(c, [coll("rej", { status: "rejected", accountId: "acc-2" })]), { kind: "none" }, "account");
  assert.deepEqual(classifyLateArrival(credit({ accountId: null }), [coll("x", { status: "confirmed", accountId: null })]), { kind: "none" });
  assert.deepEqual(classifyLateArrival(c, [coll("a", { status: "auto_confirmed" })]), { kind: "none" });
});
