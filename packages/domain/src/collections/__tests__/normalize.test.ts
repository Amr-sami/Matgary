// Run: npm test -w @matgary/domain
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  accountMask,
  fromPiasters,
  maskPayerName,
  normalizeDigits,
  normalizeEgyptMobile,
  normalizeIban,
  normalizeSender,
  normalizeText,
  normalizeWalletMsisdn,
  phoneLast4,
  senderKindOf,
  toPiasters,
} from "../normalize";

test("normalizeDigits: Arabic-Indic, extended Arabic-Indic, ٫ and ٬", () => {
  assert.equal(normalizeDigits("٠١٢٣٤٥٦٧٨٩"), "0123456789");
  assert.equal(normalizeDigits("۰۱۲۳۴۵۶۷۸۹"), "0123456789");
  assert.equal(normalizeDigits("٢٬٧٠٠٫٥٠"), "2,700.50");
  assert.equal(normalizeDigits("abc 12"), "abc 12");
});

test("normalizeText: bidi marks, zero-width, BOM and tatweel are stripped", () => {
  assert.equal(normalizeText("بـ"), "ب");
  assert.equal(normalizeText("‏تم‎ ‫استلام‬⁦⁩؜﻿​"), "تم استلام");
  assert.equal(normalizeText("مبـــلغ"), "مبلغ");
});

test("normalizeText: letter folding", () => {
  assert.equal(normalizeText("إستلام"), "استلام");
  assert.equal(normalizeText("أضافة"), "اضافه");
  assert.equal(normalizeText("آخر ٱسم"), "اخر اسم");
  assert.equal(normalizeText("الحالى"), "الحالي");
  assert.equal(normalizeText("المعاملة"), "المعامله");
});

test("normalizeText: digits become ASCII", () => {
  assert.equal(normalizeText("مبلغ ٢٧٠٠٫٠٠ جنيه"), "مبلغ 2700.00 جنيه");
});

test("normalizeText: newlines kept, spaces collapsed (VF-1's double space)", () => {
  // VF-1 [wallets.md §5.1] has "محفظتك  0100…" with two spaces and several lines.
  const raw = "على رقم محفظتك  0100\r\nرصيدك الحالي: 2724.51 جنيه  \r\n\n  تاريخ العملية:\t17:36";
  assert.equal(normalizeText(raw), "علي رقم محفظتك 0100\nرصيدك الحالي: 2724.51 جنيه\nتاريخ العمليه: 17:36");
  assert.equal(normalizeText("a  b　c"), "a b c");
  assert.equal(normalizeText("  \n x \n\n\n y \n "), "x\ny");
});

test("normalizeText: Latin case is kept", () => {
  assert.equal(normalizeText("IPN Transfer RECEIVED"), "IPN Transfer RECEIVED");
});

test("normalizeSender: trim, collapse, lower-case (D06-b)", () => {
  assert.equal(normalizeSender("  BanK-AlAhly "), "bank-alahly");
  assert.equal(normalizeSender("QNB   EGYPT"), "qnb egypt");
  assert.equal(normalizeSender("اورنج  كاش"), "اورنج كاش");
  assert.equal(normalizeSender(null), "");
  assert.equal(normalizeSender(undefined), "");
});

test("senderKindOf", () => {
  assert.equal(senderKindOf("ios_sms", "1234"), "numeric");
  assert.equal(senderKindOf("android_sms", "+20 100 123 4567"), "numeric");
  assert.equal(senderKindOf("ios_sms", "٠١٠٠-١٢٣"), "numeric");
  assert.equal(senderKindOf("ios_sms", "vf-cash"), "alphanumeric");
  assert.equal(senderKindOf("android_sms", "اورنج كاش"), "alphanumeric");
  assert.equal(senderKindOf("manual_paste", "AHLY"), "alphanumeric");
  assert.equal(senderKindOf("ios_notification", null), "app");
  assert.equal(senderKindOf("android_notification", "1234"), "app");
  assert.equal(senderKindOf("ios_sms", ""), "numeric");
  assert.equal(senderKindOf("ios_sms", "   "), "numeric");
  assert.equal(senderKindOf("manual_paste", null), "numeric");
});

test("toPiasters: accepted forms", () => {
  assert.equal(toPiasters("2,700.00"), 270000);
  assert.equal(toPiasters("500.5"), 50050);
  assert.equal(toPiasters("20000"), 2000000);
  assert.equal(toPiasters("٢٠٠٠.٠٠"), 200000);
  assert.equal(toPiasters("0.01"), 1);
  assert.equal(toPiasters("0"), 0);
  assert.equal(toPiasters(" 64,500.00 "), 6450000);
  assert.equal(toPiasters(2700), 270000);
  assert.equal(toPiasters(500.5), 50050);
  assert.equal(toPiasters(0.1 + 0.2), 30);
  assert.equal(toPiasters("999999999999.99"), 99999999999999);
  assert.ok(Number.isInteger(toPiasters("1.1")));
});

test("toPiasters: rejects with RangeError", () => {
  for (const bad of ["1.234", "-5", "abc", "", ".5", "5.", "1e3", "1,2.3.4", "12 34"]) {
    assert.throws(() => toPiasters(bad), RangeError, JSON.stringify(bad));
  }
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.234]) {
    assert.throws(() => toPiasters(bad), RangeError, String(bad));
  }
});

test("fromPiasters", () => {
  assert.equal(fromPiasters(270000), "2700.00");
  assert.equal(fromPiasters(50050), "500.50");
  assert.equal(fromPiasters(1), "0.01");
  assert.equal(fromPiasters(0), "0.00");
  assert.equal(fromPiasters(-150), "-1.50");
  assert.throws(() => fromPiasters(1.5), RangeError);
  for (const s of ["2700.00", "0.05", "64500.00", "433.80"]) assert.equal(fromPiasters(toPiasters(s)), s);
});

test("normalizeEgyptMobile: the inputs of validators/egypt.ts plus 0020 and landlines", () => {
  const expected = { national: "01001234567", e164: "+201001234567" };
  for (const input of [
    "01001234567",
    "1001234567",
    "+201001234567",
    "00201001234567",
    "+20 100 123 4567",
    "٠١٠٠١٢٣٤٥٦٧",
    "201001234567",
    "(010) 0123-4567",
  ]) {
    assert.deepEqual(normalizeEgyptMobile(input), expected, input);
  }
  assert.deepEqual(normalizeEgyptMobile("0020 112 777 7705"), { national: "01127777705", e164: "+201127777705" });
  assert.deepEqual(normalizeEgyptMobile("01512345678"), { national: "01512345678", e164: "+201512345678" });
  assert.equal(normalizeEgyptMobile("0223456789"), null, "Cairo landline");
  assert.equal(normalizeEgyptMobile("01312345678"), null, "second digit not in 0125");
  assert.equal(normalizeEgyptMobile("0020123456789"), null, "EM-2's 13-digit 0020… account");
  assert.equal(normalizeEgyptMobile(""), null);
  assert.equal(normalizeEgyptMobile(null), null);
  assert.equal(normalizeEgyptMobile("0100123456"), null, "too short");
});

test("normalizeWalletMsisdn: E.164 matching §B.2.1", () => {
  const re = /^\+201[0125]\d{8}$/;
  for (const input of ["01001234567", "+20 111 777 7705", "٠١٢٠٠١٢٣٤٥٦", "00201512345678"]) {
    const v = normalizeWalletMsisdn(input);
    assert.ok(v !== null && re.test(v), `${input} → ${v}`);
  }
  assert.equal(normalizeWalletMsisdn("0223456789"), null);
  assert.equal(normalizeWalletMsisdn("abc"), null);
  assert.equal(normalizeWalletMsisdn(undefined), null);
});

test("normalizeIban: mod-97 (ISO 13616)", () => {
  assert.equal(normalizeIban("EG380019000500000000263180002"), "EG380019000500000000263180002");
  assert.equal(normalizeIban("EG38 0019 0005 0000 0000 2631 8000 2"), "EG380019000500000000263180002");
  assert.equal(normalizeIban("eg38 0019 0005 0000 0000 2631 8000 2"), "EG380019000500000000263180002");
  assert.equal(normalizeIban("EG380019000500000000263180003"), null, "wrong check digit");
  assert.equal(normalizeIban("EG38001900050000000026318000"), null, "too short");
  assert.equal(normalizeIban("GB82WEST12345698765432"), null, "valid IBAN, not Egyptian");
  assert.equal(normalizeIban(""), null);
  assert.equal(normalizeIban(null), null);
});

test("phoneLast4", () => {
  assert.equal(phoneLast4("01127777705"), "7705");
  assert.equal(phoneLast4("+20 100 123 4567"), "4567");
  assert.equal(phoneLast4("٠١٠٠١٢٣٤٥٦٧"), "4567");
  assert.equal(phoneLast4("123"), null);
  assert.equal(phoneLast4(null), null);
});

test("maskPayerName: Latin, Arabic, one word, empty", () => {
  assert.equal(maskPayerName("AHMED MOHAMED ABDELRAHMAN"), "AHMED M****");
  assert.equal(maskPayerName("  MOHAMED   AHMED "), "MOHAMED A****");
  assert.equal(maskPayerName("محمد احمد علي"), "محمد ا****");
  assert.equal(maskPayerName("AHMED"), "AHMED ****");
  assert.equal(maskPayerName(""), null);
  assert.equal(maskPayerName("   "), null);
  assert.equal(maskPayerName(null), null);
});

test("accountMask: the four branches, ASCII only", () => {
  assert.equal(accountMask({ accountLast4: "0150", walletMsisdn: "+201001234567" }), "***0150");
  assert.equal(accountMask({ walletMsisdn: "+201001234567" }), "***4567");
  assert.equal(accountMask({ ipaHandle: "shop@instapay" }), "***@instapay");
  assert.equal(accountMask({ isPrepaidCard: true }), "***");
  assert.equal(accountMask({}), "***");
  for (const m of ["***0150", accountMask({ ipaHandle: "x@instapay" })]) {
    assert.ok(/^[\x20-\x7E]+$/.test(m), "ASCII only");
  }
});
