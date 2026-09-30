// Run: npm test -w @matgary/domain   (or npx tsx --test packages/domain/src/collections/__tests__/types.test.ts)
//
// Pins every §B.1 union of 03-architecture.md, literally and in order. When a
// value is added to 03 §B.1, add it here and in types.ts together.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as t from "../types";

const B1: Record<string, readonly string[]> = {
  PAYMENT_METHOD_VALUES: ["cash", "instapay", "wallet", "card", "deferred"],
  DIGITAL_METHOD_VALUES: ["instapay", "wallet"],
  SETTLEMENT_METHOD_VALUES: ["cash", "instapay", "wallet", "card"],
  SALE_PAYMENT_METHOD_VALUES: ["cash", "instapay", "wallet", "card", "initial"],
  COLLECTION_RAIL_VALUES: ["instapay", "wallet"],
  COLLECTION_PROVIDER_VALUES: [
    "nbe", "cib", "qnb", "banque_misr", "bdc", "aaib", "alexbank", "hsbc", "faisal", "adib", "other_bank",
    "vodafone_cash", "etisalat_money", "orange_cash", "we_pay", "nbe_phone_cash", "bm_wallet", "other_wallet",
  ],
  COLLECTION_STATUS_VALUES: ["pending", "confirmed", "auto_confirmed", "rejected", "void"],
  SALE_COLLECTION_STATUS_VALUES: ["pending", "confirmed", "rejected"],
  COLLECTION_SOURCE_TYPE_VALUES: ["sale", "settlement"],
  REJECT_REASON_VALUES: ["not_received", "wrong_amount", "wrong_account", "duplicate", "other"],
  REJECT_OUTCOME_VALUES: ["debt", "loss"],
  COLLECTION_FLAG_VALUES: [
    "account_inactive", "account_missing", "parts_clamped", "total_changed", "returned", "offline_rung", "via_provider",
  ],
  DEVICE_HEALTH_VALUES: ["ok", "never_seen", "silent", "listener_off", "heartbeat_late", "revoked"],
  LIMIT_WARNING_VALUES: ["day_80", "month_80", "new_wallet_day_80", "balance_90"],
  INGEST_RESULT_REASON_VALUES: [
    "parsed", "fallback", "unknown_format", "not_credit", "otp", "too_old", "duplicate", "channel_not_allowed",
  ],
  COLLECTION_EVENT_KIND_VALUES: [
    "created", "matched", "auto_confirmed", "confirmed", "rejected", "reopened", "voided",
    "amount_changed", "account_changed", "evidence_attached", "stale_alerted", "note",
  ],
  INGEST_CHANNEL_VALUES: [
    "ios_notification", "ios_sms", "android_notification", "android_sms", "manual_paste", "statement",
  ],
  INGEST_PLATFORM_VALUES: ["ios_shortcut", "ios_app_intent", "android_listener", "android_collector"],
  SENDER_KIND_VALUES: ["alphanumeric", "numeric", "app"],
  CREDIT_DIRECTION_VALUES: ["credit", "debit", "cash_in"],
  CREDIT_STATE_VALUES: ["unmatched", "held", "matched", "ignored", "info"],
  HOLD_REASON_VALUES: [
    "ambiguous", "untrusted_source", "balance_mismatch", "no_balance_baseline", "above_review_limit",
    "no_account", "unverified_format", "manual_source", "suspicious_link", "too_old", "amount_mismatch",
    "auto_confirm_off", "matches_rejected", "test",
  ],
  IGNORE_REASON_VALUES: ["personal", "not_a_sale", "duplicate", "other"],
  PARSE_STATUS_VALUES: ["parsed", "fallback", "unknown_format", "not_credit", "otp", "too_old", "duplicate"],
  TEMPLATE_AUTO_CONFIRM_VALUES: ["balance", "reference", "never"],
  TEMPLATE_STATUS_VALUES: ["published_sample", "pilot_verified"],
};

test("every §B.1 union equals the literal list, in order", () => {
  const mod = t as unknown as Record<string, unknown>;
  for (const [name, expected] of Object.entries(B1)) {
    assert.ok(Array.isArray(mod[name]), `${name} is exported as an array`);
    assert.deepEqual([...(mod[name] as readonly string[])], [...expected], name);
  }
});

test("no *_VALUES array is exported without a pin here", () => {
  const exported = Object.keys(t).filter((k) => k.endsWith("_VALUES")).sort();
  assert.deepEqual(exported, Object.keys(B1).sort());
});

test("no union has duplicate values", () => {
  for (const [name, values] of Object.entries(B1)) {
    assert.equal(new Set(values).size, values.length, `${name} has a duplicate`);
  }
});

test("HOLD_REASON_VALUES has 14 values and PARSE_STATUS_VALUES has 7", () => {
  assert.equal(t.HOLD_REASON_VALUES.length, 14);
  assert.equal(t.PARSE_STATUS_VALUES.length, 7);
});

test("isDigitalMethod is true only for instapay and wallet", () => {
  for (const m of t.PAYMENT_METHOD_VALUES) {
    assert.equal(t.isDigitalMethod(m), m === "instapay" || m === "wallet", m);
  }
  for (const m of ["initial", "", "INSTAPAY", "bank_transfer", "vfcash"]) {
    assert.equal(t.isDigitalMethod(m), false, m);
  }
  assert.deepEqual([...t.DIGITAL_METHODS].sort(), ["instapay", "wallet"]);
});

test("subset relations the server relies on", () => {
  const pm = new Set<string>(t.PAYMENT_METHOD_VALUES);
  for (const m of t.DIGITAL_METHOD_VALUES) assert.ok(pm.has(m), `DigitalMethod ${m} ⊂ PaymentMethod`);
  for (const m of t.SETTLEMENT_METHOD_VALUES) assert.ok(pm.has(m), `SettlementMethod ${m} ⊂ PaymentMethod`);
  assert.deepEqual([...t.COLLECTION_RAIL_VALUES], [...t.DIGITAL_METHOD_VALUES], "rails = digital methods");
  const cs = new Set<string>(t.COLLECTION_STATUS_VALUES);
  for (const s of t.SALE_COLLECTION_STATUS_VALUES) assert.ok(cs.has(s), `sale status ${s} ⊂ CollectionStatus`);
});

test("the unions are usable as types (compile-time pin)", () => {
  const method: t.PaymentMethod = "wallet";
  const reason: t.HoldReason = "test";
  const status: t.ParseStatus = "duplicate";
  const flag: t.CollectionFlag = "via_provider";
  const health: t.DeviceHealth = "heartbeat_late";
  const ingest: t.IngestResultReason = "channel_not_allowed";
  assert.deepEqual([method, reason, status, flag, health, ingest], [
    "wallet", "test", "duplicate", "via_provider", "heartbeat_late", "channel_not_allowed",
  ]);
});
