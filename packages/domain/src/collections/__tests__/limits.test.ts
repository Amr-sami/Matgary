// Run: npm test -w @matgary/domain
import { test } from "node:test";
import assert from "node:assert/strict";

import { INSTAPAY_LIMITS, WALLET_LIMITS, instapayPartWarning, limitWarnings, type LimitWarningsInput } from "../limits";
import { LIMIT_WARNING_VALUES } from "../types";

const base: LimitWarningsInput = {
  rail: "wallet",
  provider: "vodafone_cash",
  date: "2026-09-30",
  walletOpenedOn: null,
  dayReceived: "0.00",
  monthReceived: "0.00",
  balance: null,
};
const w = (over: Partial<LimitWarningsInput>) => limitWarnings({ ...base, ...over });

test("the published limits", () => {
  assert.deepEqual(WALLET_LIMITS.individual, { dayMax: 60_000, monthMax: 200_000 });
  assert.equal(WALLET_LIMITS.newWallet.days, 90);
  assert.equal(WALLET_LIMITS.newWallet.dayMax, 10_000);
  assert.equal(WALLET_LIMITS.newWallet.monthMax, 60_000);
  assert.equal(WALLET_LIMITS.newWallet.providers, "all", "D06-e default");
  assert.equal(WALLET_LIMITS.warnAtPct, 80);
  assert.equal(WALLET_LIMITS.balanceWarnAtPct, 90);
  assert.equal(INSTAPAY_LIMITS.perTransaction, 70_000);
  assert.equal(INSTAPAY_LIMITS.receiving, null);
});

test("the instapay rail never warns (receiving is unlimited)", () => {
  assert.deepEqual(
    w({ rail: "instapay", provider: "nbe", dayReceived: "500000", monthReceived: "900000", walletOpenedOn: "2026-09-29" }),
    [],
  );
});

test("day_80 at ≥ 48,000 (inclusive)", () => {
  assert.deepEqual(w({ dayReceived: "47,999.99" }), []);
  assert.deepEqual(w({ dayReceived: "48000" }), ["day_80"]);
  assert.deepEqual(w({ dayReceived: "59999.99" }), ["day_80"]);
});

test("month_80 at ≥ 160,000 (inclusive)", () => {
  assert.deepEqual(w({ monthReceived: "159999.99" }), []);
  assert.deepEqual(w({ monthReceived: "160000" }), ["month_80"]);
});

test("new_wallet_day_80: opened 89 days before warns at 8,000; 90 days before does not", () => {
  // 2026-09-30 − 89 days = 2026-07-03; − 90 days = 2026-07-02.
  assert.deepEqual(w({ walletOpenedOn: "2026-07-03", dayReceived: "8000" }), ["new_wallet_day_80"]);
  assert.deepEqual(w({ walletOpenedOn: "2026-07-02", dayReceived: "8000" }), []);
  assert.deepEqual(w({ walletOpenedOn: "2026-07-03", dayReceived: "7999.99" }), []);
  assert.deepEqual(w({ walletOpenedOn: "2026-09-30", dayReceived: "8000" }), ["new_wallet_day_80"], "opened today");
  assert.deepEqual(w({ walletOpenedOn: null, dayReceived: "8000" }), []);
  assert.deepEqual(w({ walletOpenedOn: "not-a-date", dayReceived: "8000" }), []);
});

test("the new-wallet rule applies to every wallet provider (D06-e)", () => {
  for (const provider of ["vodafone_cash", "etisalat_money", "orange_cash", "we_pay", "nbe_phone_cash", "bm_wallet", "other_wallet"] as const) {
    assert.deepEqual(w({ provider, walletOpenedOn: "2026-09-01", dayReceived: "8000" }), ["new_wallet_day_80"], provider);
  }
});

test("balance_90 at ≥ 90 % of the provider's cap; skipped for a null cap or balance", () => {
  assert.deepEqual(w({ provider: "vodafone_cash", balance: "90000" }), ["balance_90"]);
  assert.deepEqual(w({ provider: "vodafone_cash", balance: "89999.99" }), []);
  assert.deepEqual(w({ provider: "orange_cash", balance: "180000" }), ["balance_90"]);
  assert.deepEqual(w({ provider: "orange_cash", balance: "90000" }), []);
  assert.deepEqual(w({ provider: "bm_wallet", balance: "99999999" }), [], "null cap");
  assert.deepEqual(w({ provider: "vodafone_cash", balance: null }), []);
});

test("the output order is fixed: day_80, month_80, new_wallet_day_80, balance_90", () => {
  const all = w({
    provider: "vodafone_cash",
    walletOpenedOn: "2026-09-01",
    dayReceived: "50000",
    monthReceived: "170000",
    balance: "95000",
  });
  assert.deepEqual(all, ["day_80", "month_80", "new_wallet_day_80", "balance_90"]);
  assert.deepEqual(all, [...LIMIT_WARNING_VALUES]);
});

test("instapayPartWarning above EGP 70,000 per transaction", () => {
  assert.equal(instapayPartWarning("70000.01"), "over_per_transaction");
  assert.equal(instapayPartWarning("70000"), null);
  assert.equal(instapayPartWarning("70,000.00"), null);
  assert.equal(instapayPartWarning("150"), null);
  assert.throws(() => instapayPartWarning("abc"), RangeError);
});
