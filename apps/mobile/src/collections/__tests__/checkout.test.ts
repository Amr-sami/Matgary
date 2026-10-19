/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/collections/__tests__/checkout.test.ts
 *
 * `checkout.ts` has type-only imports, so plain Node loads it. Cases: doc 15
 * spec 08 §7 (checkout.test.ts row).
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import * as co from "../checkout.ts";

type Account = co.AccountLike;

const acc = (over: Partial<Account> & Pick<Account, "id" | "rail">): Account => ({
  branchId: null,
  provider: over.rail === "wallet" ? "vodafone_cash" : "cib",
  label: over.id,
  ipaHandle: null,
  ipaLink: null,
  accountLast4: null,
  walletMsisdn: null,
  isPosDefault: false,
  sortOrder: 0,
  archivedAt: null,
  mask: "***",
  ...over,
});

const CIB = acc({ id: "cib", rail: "instapay", isPosDefault: true, ipaHandle: "amr@instapay", label: "CIB" });
const NBE = acc({ id: "nbe", rail: "instapay", label: "NBE", sortOrder: 1 });
const VF = acc({ id: "vf", rail: "wallet", isPosDefault: true, walletMsisdn: "+201012345678", label: "VF" });
const ORANGE = acc({ id: "or", rail: "wallet", label: "Orange", sortOrder: 2 });
const ARCHIVED = acc({ id: "old", rail: "wallet", archivedAt: "2026-09-01T00:00:00Z" });
const OTHER_BRANCH = acc({ id: "b2", rail: "instapay", branchId: "branch-2" });
const ALL = [ORANGE, NBE, ARCHIVED, VF, OTHER_BRANCH, CIB];

test("emptyPayment is cash with nothing picked", () => {
  assert.deepEqual(co.emptyPayment(), {
    paymentMethod: "cash",
    collectionAccountId: null,
    payerPhoneLast4: "",
    payerReference: "",
    collectionParts: [],
  });
});

test("posPaymentMethods: today's four when off; wallet between instapay and card when on", () => {
  assert.deepEqual(co.posPaymentMethods(false), ["cash", "instapay", "card", "deferred"]);
  assert.deepEqual(co.posPaymentMethods(true), ["cash", "instapay", "wallet", "card", "deferred"]);
});

test("accountsForMethod: archived + other-branch dropped; wallet rail only; instapay rails first then wallets; default first", () => {
  assert.deepEqual(co.accountsForMethod("wallet", ALL, "branch-1").map((a) => a.id), ["vf", "or"]);
  assert.deepEqual(co.accountsForMethod("instapay", ALL, "branch-1").map((a) => a.id), ["cib", "nbe", "vf", "or"]);
  // Same branch keeps its own rows.
  assert.ok(co.accountsForMethod("instapay", ALL, "branch-2").some((a) => a.id === "b2"));
  // Unknown active branch: the server already scoped the list.
  assert.ok(co.accountsForMethod("instapay", ALL, null).some((a) => a.id === "b2"));
  assert.deepEqual(co.accountsForMethod("cash", ALL, "branch-1"), []);
  assert.deepEqual(co.accountsForMethod("wallet", null, "branch-1"), []);
});

test("defaultAccountFor: POS default wins, a single account wins, otherwise null", () => {
  assert.equal(co.defaultAccountFor("instapay", ALL, "branch-1"), "cib");
  assert.equal(co.defaultAccountFor("wallet", ALL, "branch-1"), "vf");
  assert.equal(co.defaultAccountFor("wallet", [ORANGE], "b"), "or");
  assert.equal(co.defaultAccountFor("instapay", [NBE, ORANGE], "b"), null);
  // InstaPay with only a wallet listed: the single listed account.
  assert.equal(co.defaultAccountFor("instapay", [ORANGE], "b"), "or");
  assert.equal(co.defaultAccountFor("card", ALL, "b"), null);
});

const single = (over: Partial<co.CartPaymentFields> = {}): co.CartPaymentFields => ({
  ...co.emptyPayment(),
  paymentMethod: "instapay",
  collectionAccountId: "cib",
  payerPhoneLast4: "1234",
  payerReference: "ab12",
  ...over,
});

test("enterSplit moves the account + payer into part 1 with amount = total", () => {
  const s = co.enterSplit(single(), 1000);
  assert.deepEqual(s.collectionParts, [{ accountId: "cib", amount: 1000, payerPhoneLast4: "1234", payerReference: "ab12" }]);
  assert.equal(s.collectionAccountId, null);
  assert.equal(s.payerPhoneLast4, "");
  assert.equal(s.payerReference, "");
  // Idempotent in parts mode.
  assert.equal(co.enterSplit(s, 1000), s);
});

test("addPart fills the remainder, never below 0, and stops at 4", () => {
  let s = co.enterSplit(single(), 1000);
  s = co.updatePart(s, 0, { amount: 600 });
  s = co.addPart(s, 1000, "vf");
  assert.deepEqual(s.collectionParts[1], { accountId: "vf", amount: 400, payerPhoneLast4: "", payerReference: "" });
  s = co.addPart(s, 1000, "vf");
  assert.equal(s.collectionParts[2]!.amount, 0);
  s = co.addPart(s, 1000, "vf");
  assert.equal(s.collectionParts.length, 4);
  const again = co.addPart(s, 1000, "vf");
  assert.equal(again.collectionParts.length, co.MAX_PARTS);
  // From single mode: enters split first, then appends.
  const fromSingle = co.addPart(single(), 1000, "vf");
  assert.equal(fromSingle.collectionParts.length, 2);
  assert.equal(fromSingle.collectionParts[0]!.amount, 1000);
  assert.equal(fromSingle.collectionParts[1]!.amount, 0);
});

test("T1 F2: the split state behind 'enter each amount' + 'more than the total' — validation was right", () => {
  // The Android POS showed both errors with Record disabled. Replayed here:
  // "add part" from single mode → [8450, 0]; the amount field's caret sat
  // BEFORE the digits (RTL paragraph, Field.tsx inputForceLtr), so backspace
  // deleted nothing and "1" made "18450"; the flow then added a third part
  // (it took an off-screen part 2 for a missing one) with nothing left → 0.
  const total = 8450;
  let s = co.addPart(single(), total, "vf");
  assert.deepEqual(s.collectionParts.map((p) => p.amount), [8450, 0]);
  s = co.updatePart(s, 0, { amount: co.parseAmountInput("18450") });
  s = co.addPart(s, total, "vf");
  assert.deepEqual(s.collectionParts.map((p) => p.amount), [18450, 0, 0]);
  s = co.updatePart(s, 1, { amount: co.parseAmountInput("1") });
  const bad = co.validateTransfer(s, { total, collectionsOn: true, requireAccount: true, accounts: null });
  assert.deepEqual(bad.errors, ["part_amount_invalid", "parts_exceed_total"]);
  // With the caret at the end the field holds "1": two parts of EGP 1 record.
  let ok = co.addPart(single(), total, "vf");
  ok = co.updatePart(ok, 0, { amount: co.parseAmountInput("1") });
  ok = co.updatePart(ok, 1, { amount: co.parseAmountInput("1") });
  assert.equal(co.cashRemainder(total, ok.collectionParts), 8448);
  assert.deepEqual(co.validateTransfer(ok, { total, collectionsOn: true, requireAccount: true, accounts: null }), {
    ok: true,
    errors: [],
    warnings: [],
  });
});

test("T1 I2 (iOS): every key went to part 1 — [1, 0] shows remainder 3,599 and 'enter each amount'", () => {
  // The iPhone POS showed "remainder 3,599" with "enter each transfer's
  // amount" and Record disabled. Replayed from the run's maestro.log: total
  // 3600 → [3600, 0]; part 1 "3600" → erase → "1". The tap meant for part 2
  // (y 571) hit the number pad's "2" while part 1 still had focus → "12";
  // erase → ""; "1" → part 1 = 1, and part 2 never left 0. One EGP short of
  // the expected 3,598 is the tell; the validation and remainder are right.
  const total = 3600;
  let s = co.addPart(single(), total, "vf");
  for (const typed of ["1", "12", "", "1"]) s = co.updatePart(s, 0, { amount: co.parseAmountInput(typed) });
  assert.deepEqual(s.collectionParts.map((p) => p.amount), [1, 0]);
  assert.equal(co.cashRemainder(total, s.collectionParts), 3599);
  assert.deepEqual(co.validateTransfer(s, { total, collectionsOn: true, requireAccount: true, accounts: null }).errors, [
    "part_amount_invalid",
  ]);
  s = co.updatePart(s, 1, { amount: co.parseAmountInput("1") });
  assert.equal(co.cashRemainder(total, s.collectionParts), 3598);
  assert.equal(co.validateTransfer(s, { total, collectionsOn: true, requireAccount: true, accounts: null }).ok, true);
});

test("removing back to one full part collapses to single mode; a partial part stays split", () => {
  let s = co.addPart(single(), 1000, "vf");
  s = co.removePart(s, 1, 1000);
  assert.deepEqual(s, single());
  let p = co.enterSplit(single(), 1000);
  p = co.updatePart(p, 0, { amount: 600 });
  p = co.addPart(p, 1000, "vf");
  p = co.removePart(p, 1, 1000);
  assert.equal(p.collectionParts.length, 1);
  assert.equal(p.collectionParts[0]!.amount, 600);
  // Removing the last part → single mode, nothing picked.
  const none = co.removePart(p, 0, 1000);
  assert.deepEqual(none.collectionParts, []);
  // Out of range is a no-op.
  assert.equal(co.removePart(p, 5, 1000), p);
});

test("cashRemainder / partsTotal work in piasters (0.1 + 0.2)", () => {
  assert.equal(co.cashRemainder(0.3, [{ amount: 0.1 }, { amount: 0.2 }]), 0);
  assert.equal(co.partsTotal([{ amount: 0.1 }, { amount: 0.2 }]), 0.3);
  assert.equal(co.cashRemainder(1000, [{ amount: 600 }, { amount: 300 }]), 100);
  assert.equal(co.cashRemainder(1000, [{ amount: 1100 }]), -100);
});

const ctx = (over: Partial<co.TransferValidationContext> = {}): co.TransferValidationContext => ({
  total: 1000,
  collectionsOn: true,
  requireAccount: true,
  accounts: [CIB, VF],
  ...over,
});

test("validateTransfer: account_required only when required + accounts known + listed", () => {
  const none = single({ collectionAccountId: null });
  assert.deepEqual(co.validateTransfer(none, ctx()).errors, ["account_required"]);
  assert.equal(co.validateTransfer(none, ctx({ requireAccount: false })).ok, true);
  // Settings unknown → the server default (true).
  assert.deepEqual(co.validateTransfer(none, ctx({ requireAccount: null })).errors, ["account_required"]);
  // Zero accounts → the sale can still be rung.
  assert.equal(co.validateTransfer(none, ctx({ accounts: [] })).ok, true);
  // Accounts unknown → no account_required.
  assert.equal(co.validateTransfer(none, ctx({ accounts: null })).ok, true);
  // A picked id that is no longer listed counts as none.
  assert.deepEqual(co.validateTransfer(single({ collectionAccountId: "gone" }), ctx()).errors, ["account_required"]);
  assert.equal(co.validateTransfer(single(), ctx()).ok, true);
});

test("validateTransfer: parts rules (amount, Σ > total, > 4 parts, account on every part)", () => {
  const parts = (...ps: [string | null, number][]): co.CartPaymentFields => ({
    ...co.emptyPayment(),
    paymentMethod: "instapay",
    collectionParts: ps.map(([accountId, amount]) => ({ accountId, amount, payerPhoneLast4: "", payerReference: "" })),
  });
  assert.equal(co.validateTransfer(parts(["cib", 600], ["vf", 300]), ctx()).ok, true);
  assert.deepEqual(co.validateTransfer(parts(["cib", 600], ["vf", 0]), ctx()).errors, ["part_amount_invalid"]);
  assert.deepEqual(co.validateTransfer(parts(["cib", 600], ["vf", 500]), ctx()).errors, ["parts_exceed_total"]);
  assert.deepEqual(
    co.validateTransfer(parts(["cib", 100], ["vf", 100], ["cib", 100], ["vf", 100], ["cib", 100]), ctx()).errors,
    ["too_many_parts"],
  );
  // Every part needs an account, even when the branch does not require one (03 §B.17 wire).
  assert.deepEqual(co.validateTransfer(parts(["cib", 600], [null, 300]), ctx({ requireAccount: false })).errors, ["account_required"]);
});

test("validateTransfer: payer last-4 and reference formats; spaces and dashes stripped (R12)", () => {
  assert.deepEqual(co.validateTransfer(single({ payerPhoneLast4: "12a4" }), ctx()).errors, ["payer_last4_invalid"]);
  assert.deepEqual(co.validateTransfer(single({ payerPhoneLast4: "123" }), ctx()).errors, ["payer_last4_invalid"]);
  assert.deepEqual(co.validateTransfer(single({ payerReference: "ab" }), ctx()).errors, ["reference_invalid"]);
  assert.deepEqual(co.validateTransfer(single({ payerReference: "ab_12" }), ctx()).errors, ["reference_invalid"]);
  assert.equal(co.validateTransfer(single({ payerReference: "AB-12 34" }), ctx()).ok, true);
  assert.equal(co.validateTransfer(single({ payerPhoneLast4: "", payerReference: "" }), ctx()).ok, true);
});

test("validateTransfer: the 70,000 InstaPay limit is a warning, not an error", () => {
  const big = co.validateTransfer(single(), ctx({ total: 80000 }));
  assert.equal(big.ok, true);
  assert.deepEqual(big.warnings, ["instapay_over_limit"]);
  assert.deepEqual(co.validateTransfer(single({ paymentMethod: "wallet", collectionAccountId: "vf" }), ctx({ total: 80000 })).warnings, []);
  const splitOk = co.updatePart(co.addPart(co.enterSplit(single(), 100000), 100000, "cib"), 0, { amount: 60000 });
  assert.deepEqual(co.validateTransfer(splitOk, ctx({ total: 100000 })).warnings, []);
});

test("validateTransfer: non-digital methods and the feature off never block", () => {
  assert.equal(co.validateTransfer(single({ paymentMethod: "cash", collectionAccountId: null }), ctx()).ok, true);
  assert.equal(co.validateTransfer(single({ collectionAccountId: null }), ctx({ collectionsOn: false })).ok, true);
});

test("collectionOptionsFromCart: each §4.3 row", () => {
  // cash / card / deferred: nothing, even with stale fields.
  assert.deepEqual(co.collectionOptionsFromCart(single({ paymentMethod: "cash" }), 1000, true), {});
  assert.deepEqual(co.collectionOptionsFromCart(single({ paymentMethod: "deferred" }), 1000, true), {});
  // Feature off: nothing.
  assert.deepEqual(co.collectionOptionsFromCart(single(), 1000, false), {});
  // Single, account picked (+ reference normalised).
  assert.deepEqual(co.collectionOptionsFromCart(single({ payerReference: "AB-12" }), 1000, true), {
    collectionAccountId: "cib",
    payerPhoneLast4: "1234",
    payerReference: "AB12",
  });
  // Single, no account: payer fields only; empty payer fields omitted.
  assert.deepEqual(co.collectionOptionsFromCart(single({ collectionAccountId: null, payerReference: "" }), 1000, true), {
    payerPhoneLast4: "1234",
  });
  // Parts: collectionParts only, no top-level single fields.
  const split = co.updatePart(co.addPart(co.enterSplit(single(), 1000), 1000, "vf"), 0, { amount: 600 });
  const body = co.collectionOptionsFromCart(split, 1000, true);
  assert.deepEqual(body, {
    collectionParts: [
      { accountId: "cib", amount: 600, payerPhoneLast4: "1234", payerReference: "ab12" },
      { accountId: "vf", amount: 0 },
    ],
  });
  assert.equal("collectionAccountId" in body, false);
});

test("round trip: collectionOptionsFromCart(cartPaymentFromOptions(o)) equals o's collection subset", () => {
  const cases: co.CollectionOptions[] = [
    { collectionAccountId: "cib", payerPhoneLast4: "1234", payerReference: "ab12" },
    { payerPhoneLast4: "9876" },
    {},
    {
      collectionParts: [
        { accountId: "cib", amount: 500, payerPhoneLast4: "1111" },
        { accountId: "vf", amount: 300.5, payerReference: "ffee00" },
        { accountId: "cib", amount: 99.25 },
      ],
    },
  ];
  for (const subset of cases) {
    for (const paymentMethod of ["instapay", "wallet"] as const) {
      const o = { paymentMethod, invoiceId: "INV-1", ...subset };
      const fields = co.cartPaymentFromOptions(o);
      assert.equal(fields.paymentMethod, paymentMethod);
      assert.deepEqual(co.collectionOptionsFromCart(fields, 1000, true), subset);
    }
  }
  // A legacy body (no method) restores cash.
  assert.deepEqual(co.cartPaymentFromOptions({ invoiceId: "INV-2" }), co.emptyPayment());
  assert.deepEqual(co.cartPaymentFromOptions(undefined), co.emptyPayment());
});

test("paymentSummaryOf: single, parts and legacy bodies", () => {
  assert.deepEqual(co.paymentSummaryOf({ paymentMethod: "wallet", collectionAccountId: "vf" }), {
    paymentMethod: "wallet",
    collectionAccountIds: ["vf"],
  });
  assert.deepEqual(
    co.paymentSummaryOf({
      paymentMethod: "instapay",
      collectionParts: [
        { accountId: "cib", amount: 1 },
        { accountId: "vf", amount: 1 },
        { accountId: "cib", amount: 1 },
      ],
    }),
    { paymentMethod: "instapay", collectionAccountIds: ["cib", "vf"] },
  );
  assert.deepEqual(co.paymentSummaryOf({ invoiceId: "x" }), { paymentMethod: null, collectionAccountIds: [] });
  assert.deepEqual(co.paymentSummaryOf({ paymentMethod: "cash" }), { paymentMethod: "cash", collectionAccountIds: [] });
});

test("formatWalletNumber reads as 010 1234 5678", () => {
  assert.equal(co.formatWalletNumber("+201012345678"), "010 1234 5678");
  assert.equal(co.formatWalletNumber("01012345678"), "010 1234 5678");
  assert.equal(co.formatWalletNumber("201112345678"), "011 1234 5678");
  assert.equal(co.formatWalletNumber("not a number"), "not a number");
  assert.equal(co.formatWalletNumber(null), "");
});

test("accountIdentity never returns an IBAN", () => {
  assert.equal(co.accountIdentity(CIB), "amr@instapay");
  assert.equal(co.accountIdentity(VF), "010 1234 5678");
  assert.equal(co.accountIdentity(acc({ id: "b", rail: "instapay", accountLast4: "4821" })), "•••• 4821");
  // Even when the DTO carries the full IBAN (manage_collection_accounts), it is not the identity.
  const withIban = { ...acc({ id: "i", rail: "instapay", mask: "***0123" }), iban: "EG380019000500000000263180002" };
  const shown = co.accountIdentity(withIban);
  assert.equal(shown.includes("EG38"), false);
  assert.equal(shown, "***0123");
});

test("typed input: Arabic-Indic digits, the Arabic decimal separator, junk", () => {
  assert.equal(co.asciiDigits("١٢٣٤"), "1234");
  assert.equal(co.asciiDigits("۱۲"), "12");
  assert.equal(co.parseAmountInput("٦٠٠٫٥"), 600.5);
  assert.equal(co.parseAmountInput("1,250.755"), 1250.76);
  assert.equal(co.parseAmountInput(""), 0);
  assert.equal(co.parseAmountInput("abc"), 0);
  assert.equal(co.parseAmountInput("-5"), 5);
  assert.equal(co.cleanLast4Input("٠١٢٣٤٥"), "0123");
  assert.equal(co.cleanLast4Input("12a"), "12");
});
