// Run: npm test -w @matgary/domain
// Spec 06 §7 dedupe.test.ts + acceptance 10. The fingerprint vectors are the
// SHARED vectors specs 10 (iOS) and 11 (Android) reproduce natively.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { clientFingerprint, creditDedupeKey, fingerprintPreimage, sha256Hex, shouldMergeCrossChannel } from "../dedupe";

const nodeSha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

test("creditDedupeKey: the reference shape", () => {
  const base = {
    provider: "nbe" as const,
    accountId: "acc-1",
    receivingHint: "0150",
    operatorReference: "125073164743",
    amount: "5000.00",
    balanceAfter: null,
    payerPhoneLast4: null,
    occurredAt: "2026-05-04T09:25:00Z",
  };
  assert.equal(creditDedupeKey(base), "r:nbe:acc-1:125073164743");
  assert.equal(creditDedupeKey({ ...base, accountId: null }), "r:nbe:0150:125073164743");
  assert.equal(creditDedupeKey({ ...base, accountId: null, receivingHint: null, provider: null }), "r:unknown:-:125073164743");
  assert.equal(creditDedupeKey({ ...base, operatorReference: "FF961E35" }), "r:nbe:acc-1:ff961e35");
  // The reference wins over the balance.
  assert.equal(creditDedupeKey({ ...base, balanceAfter: "10.00" }), "r:nbe:acc-1:125073164743");
});

test("creditDedupeKey: the balance shape", () => {
  const c = {
    provider: "vodafone_cash" as const,
    accountId: "acc-vf",
    receivingHint: "7765",
    operatorReference: null,
    amount: "200.00",
    balanceAfter: "429.90",
    payerPhoneLast4: "7746",
    occurredAt: "2026-09-24T10:05:00Z",
  };
  assert.equal(creditDedupeKey(c), "b:acc-vf:20000:42990");
  assert.equal(creditDedupeKey({ ...c, accountId: null }), "b:vodafone_cash:20000:42990");
  assert.equal(creditDedupeKey({ ...c, accountId: null, provider: null }), "b:unknown:20000:42990");
});

test("creditDedupeKey: the fingerprint shape, its 10-minute bucket and the #n suffix", () => {
  const c = {
    provider: "other_bank" as const,
    accountId: "acc-x",
    receivingHint: "6201",
    operatorReference: null,
    amount: "20000",
    balanceAfter: null,
    payerPhoneLast4: null,
    occurredAt: "2026-08-19T12:09:59Z",
  };
  const bucket = Math.floor(Date.parse("2026-08-19T12:09:59Z") / 600_000);
  assert.equal(creditDedupeKey(c), `f:acc-x:2000000:-:${bucket}`);
  assert.equal(creditDedupeKey({ ...c, payerPhoneLast4: "1234" }), `f:acc-x:2000000:1234:${bucket}`);
  assert.equal(creditDedupeKey({ ...c, collisionIndex: 2 }), `f:acc-x:2000000:-:${bucket}#2`);
  assert.equal(creditDedupeKey({ ...c, collisionIndex: 0 }), `f:acc-x:2000000:-:${bucket}`);
  // 12:09:59 and 12:10:00 fall in different buckets …
  const next = creditDedupeKey({ ...c, occurredAt: "2026-08-19T12:10:00Z" });
  assert.equal(next, `f:acc-x:2000000:-:${bucket + 1}`);
  assert.notEqual(next, creditDedupeKey(c));
  // … and the cross-channel merge still covers them.
  assert.equal(
    shouldMergeCrossChannel(
      { accountId: "acc-x", amount: "20000", occurredAt: "2026-08-19T12:09:59Z", channels: ["android_sms"], operatorReference: null, balanceAfter: null, payerPhoneLast4: null },
      { accountId: "acc-x", amount: "20000.00", occurredAt: "2026-08-19T12:10:00Z", channel: "android_notification", operatorReference: null, balanceAfter: null, payerPhoneLast4: null },
    ),
    true,
  );
});

test("shouldMergeCrossChannel: merges SMS + notification 4 min apart; refuses the other cases", () => {
  const existing = {
    accountId: "acc-1",
    amount: "500.00",
    occurredAt: "2026-05-06T17:34:00Z",
    channels: ["android_sms"] as const,
    operatorReference: "ff961e35",
    balanceAfter: null,
    payerPhoneLast4: null,
  };
  const incoming = {
    accountId: "acc-1",
    amount: "500",
    occurredAt: "2026-05-06T17:38:00Z",
    channel: "android_notification" as const,
    operatorReference: null,
    balanceAfter: null,
    payerPhoneLast4: null,
  };
  assert.equal(shouldMergeCrossChannel(existing, incoming), true, "4 min, other channel, missing ref fills in");
  assert.equal(shouldMergeCrossChannel(existing, { ...incoming, operatorReference: "FF961E35" }), true, "same ref, any case");
  assert.equal(shouldMergeCrossChannel(existing, { ...incoming, channel: "android_sms" }), false, "same channel");
  assert.equal(shouldMergeCrossChannel(existing, { ...incoming, occurredAt: "2026-05-06T17:45:00Z" }), false, "11 min apart");
  assert.equal(shouldMergeCrossChannel(existing, { ...incoming, occurredAt: "2026-05-06T17:44:00Z" }), true, "10 min is inclusive");
  assert.equal(shouldMergeCrossChannel(existing, { ...incoming, operatorReference: "e8819e2c" }), false, "conflicting reference");
  assert.equal(
    shouldMergeCrossChannel({ ...existing, balanceAfter: "10.00" }, { ...incoming, balanceAfter: "10.50" }),
    false,
    "conflicting balances",
  );
  assert.equal(
    shouldMergeCrossChannel({ ...existing, payerPhoneLast4: "7705" }, { ...incoming, payerPhoneLast4: "1111" }),
    false,
    "conflicting payer last 4",
  );
  assert.equal(shouldMergeCrossChannel(existing, { ...incoming, amount: "500.01" }), false, "amount");
  assert.equal(shouldMergeCrossChannel(existing, { ...incoming, accountId: "acc-2" }), false, "account");
  assert.equal(shouldMergeCrossChannel({ ...existing, accountId: null }, { ...incoming, accountId: null }), false, "both null");
});

// §4.12 shared vectors (computed 2026-09-27 with node:crypto).
const VECTORS: ReadonlyArray<{ input: Parameters<typeof clientFingerprint>[0]; pre: string; sha: string }> = [
  {
    input: { kind: "android_notification", packageName: "com.egyptianbanks.instapay", title: "InstaPay", text: "Test  message\n1" },
    pre: "com.egyptianbanks.instapay|InstaPay|Test message 1",
    sha: "d2a12863b43d6398fa279b01ea4e7a2f89e2fe778afb0fa21bb5497cc159cf5d",
  },
  {
    input: { kind: "android_notification", packageName: "com.egyptianbanks.instapay", title: null, text: null },
    pre: "com.egyptianbanks.instapay||",
    sha: "4bacbdd023de576c342a52d362ff064f14787400adc05dbdf987bf3c0ffb3024",
  },
  {
    input: { kind: "ios", channel: "ios_sms", sender: "AHLY", body: "تم إضافة تحويل لحظي", receivedAtMinute: "2026-09-27T12:03" },
    pre: "ios_sms|AHLY|تم إضافة تحويل لحظي|2026-09-27T12:03",
    sha: "b06dfa4e509f0886e843e8bf9e30b391c04c7f962b1fb670a56b8dbcbe7fcad1",
  },
  {
    input: { kind: "android_sms", address: "vf-cash", body: "تم استلام مبلغ 5.00 جنيه", timestampMs: 1790000000000 },
    pre: "vf-cash|تم استلام مبلغ 5.00 جنيه|1790000000000",
    sha: "b89895a6ceade1c89058e4180326ab64cd6cc566c8d4bf3928c8a80fdc4b622e",
  },
  {
    input: { kind: "manual_paste", sender: null, body: " IPN transfer received " },
    pre: "manual_paste||IPN transfer received",
    sha: "cbf914e317454bc41dc77082a9e27ee60de2ff76531fedee9952717b0c0c4691",
  },
];

test("clientFingerprint reproduces the §4.12 shared vectors (pre-image and sha256)", () => {
  for (const v of VECTORS) {
    assert.equal(fingerprintPreimage(v.input), v.pre);
    assert.equal(clientFingerprint(v.input), v.sha, v.pre);
    assert.equal(nodeSha(v.pre), v.sha, "vector table itself");
    assert.match(v.sha, /^[A-Za-z0-9_-]{16,64}$/, "§B.2.6");
  }
});

test("fpNorm is ASCII-only: a non-breaking space is not collapsed", () => {
  const a = fingerprintPreimage({ kind: "android_notification", packageName: "p", title: "a  b", text: "\t x \r\n" });
  assert.equal(a, "p|a  b|x");
});

test("sha256Hex equals node:crypto: the empty string, FIPS vectors and 200 random UTF-8 strings (Arabic included)", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  // Block-boundary lengths (55, 56, 63, 64, 65 bytes) and a long input.
  for (const n of [55, 56, 63, 64, 65, 119, 120, 1000]) assert.equal(sha256Hex("a".repeat(n)), nodeSha("a".repeat(n)), `len ${n}`);
  // Seeded PRNG so a failure is reproducible.
  let seed = 0x5eed1234;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const ranges: Array<[number, number]> = [
    [0x20, 0x7e], // ASCII
    [0x0600, 0x06ff], // Arabic
    [0x0660, 0x0669], // Arabic-Indic digits
    [0x200b, 0x200f], // bidi marks
    [0x00a0, 0x07ff], // 2-byte
    [0x0800, 0xd7ff], // 3-byte
    [0x1f300, 0x1f6ff], // 4-byte (emoji)
  ];
  for (let i = 0; i < 200; i++) {
    const len = Math.floor(rnd() * 120);
    let s = "";
    for (let j = 0; j < len; j++) {
      const [lo, hi] = ranges[Math.floor(rnd() * ranges.length)];
      s += String.fromCodePoint(lo + Math.floor(rnd() * (hi - lo + 1)));
    }
    assert.equal(sha256Hex(s), nodeSha(s), JSON.stringify(s));
  }
  // A lone surrogate is encoded as U+FFFD, as Node's UTF-8 encoder does.
  assert.equal(sha256Hex("a\uD800b"), nodeSha("a\uD800b"));
});
