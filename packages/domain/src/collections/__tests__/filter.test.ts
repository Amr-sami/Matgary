// Run: npm test -w @matgary/domain
// Spec 06 §7 filter.test.ts + acceptance 7.
import { test } from "node:test";
import assert from "node:assert/strict";

import { SAMPLES, sampleById } from "../__fixtures__/samples";
import { CANDIDATE_KEYWORDS, FILTER_CONFIG_VERSION, OTP_PATTERNS, isCandidateMessage, isOtp } from "../filter";
import { normalizeText } from "../normalize";

const text = (id: string) => {
  const s = sampleById(id);
  assert.ok(s, id);
  return s.text;
};

test("acceptance 7: every credit fixture, VF-2 and the IPN debits are candidates", () => {
  const credits = SAMPLES.filter((s) => s.kind === "published" && s.expect.direction !== "debit").map((s) => s.id);
  assert.ok(credits.length >= 12, `credits: ${credits.join(",")}`);
  for (const id of [...credits, "VF-2", "IP-NBE-3", "IP-CIB-1-D", "IP-QNB-1-D", "IP-QNB-PAIR-D", "IP-ADIB-1"]) {
    assert.equal(isCandidateMessage({ body: text(id) }), true, id);
    // Devices match the RAW text; the published (masked) form is a candidate too.
    assert.equal(isCandidateMessage({ body: (sampleById(id) as { published: string }).published }), true, `${id} raw`);
  }
});

test("acceptance 7: the NBE merchant debit and the Zynk card / payment / ATM texts are not candidates", () => {
  for (const id of ["IP-NBE-4", "ZYNK-CARD", "ZYNK-PAY", "ZYNK-ATM", "ZYNK-OTP"]) {
    assert.equal(isCandidateMessage({ body: text(id) }), false, id);
  }
});

test("acceptance 7: isOtp is true only for ZYNK-OTP among the fixtures", () => {
  for (const s of SAMPLES) assert.equal(isOtp(s.text), s.id === "ZYNK-OTP", s.id);
  assert.equal(isOtp("Your OTP is 482910. Do not share this code."), true);
});

test("an OTP is never a candidate, even with a credit keyword", () => {
  assert.equal(isCandidateMessage({ body: "تم استلام طلبك. كود التحقق 4821 لا تشارك الكود" }), false);
  assert.equal(isCandidateMessage({ title: "IPN", body: "Your one-time code is 1234" }), false);
});

test("title and subtitle are part of the candidate text", () => {
  assert.equal(isCandidateMessage({ title: "InstaPay", subtitle: "IPN credit", body: "EGP 50.00" }), true);
  assert.equal(isCandidateMessage({ title: null, subtitle: null, body: "hello" }), false);
});

test("every OTP pattern compiles and is portable (no (?, \\b or \\p)", () => {
  for (const p of OTP_PATTERNS) {
    assert.doesNotThrow(() => new RegExp(p, "i"), p);
    assert.ok(!p.includes("(?"), p);
    assert.ok(!p.includes("\\b"), p);
    assert.ok(!p.includes("\\p"), p);
  }
});

test("OTP patterns match both the raw and the normalised spelling", () => {
  for (const raw of ["كلمة المرور الخاصة بك 1234", "رمز التحقق 5521", "كود التفعيل 8899", "صالح لمرة واحدة"]) {
    assert.equal(isOtp(raw), true, raw);
    assert.equal(isOtp(normalizeText(raw)), true, `normalised: ${raw}`);
  }
  assert.equal(isOtp("كلمه المرور"), true);
  assert.equal(isOtp("Verification Code: 1234"), true, "case-insensitive");
  assert.equal(isOtp("PASSCODE ٤٨٢٩"), true);
  assert.equal(isOtp("رمـز الـتحقق \u200F1234"), true, "tatweel and bidi marks are stripped");
  assert.equal(isOtp("Your bank: no otpa here"), false, "otp must stand alone");
});

test("CANDIDATE_KEYWORDS: no raw duplicates; raw spelling variants collapse to one normalised keyword", () => {
  for (const lang of ["ar", "en"] as const) {
    const raw = [...CANDIDATE_KEYWORDS[lang]];
    assert.equal(new Set(raw).size, raw.length, `${lang}: raw duplicate`);
  }
  // The Arabic list deliberately carries hamza / no-hamza spellings for the
  // devices' raw "contains"; normalised they are 6 distinct keywords.
  const arNorm = new Set(CANDIDATE_KEYWORDS.ar.map((k) => normalizeText(k)));
  assert.deepEqual([...arNorm].sort(), ["استقبال", "استلام", "اضافه", "ايداع", "تحويل لحظي", "تم تحويل"].sort());
  const enNorm = new Set(CANDIDATE_KEYWORDS.en.map((k) => normalizeText(k).toLowerCase()));
  assert.equal(enNorm.size, CANDIDATE_KEYWORDS.en.length);
});

test("D06-a: the wallet debit wording تم تحويل is forwarded", () => {
  assert.ok((CANDIDATE_KEYWORDS.ar as readonly string[]).includes("تم تحويل"));
});

test("FILTER_CONFIG_VERSION has the <date>-<n> shape", () => {
  assert.match(FILTER_CONFIG_VERSION, /^\d{4}-\d{2}-\d{2}-\d+$/);
});
