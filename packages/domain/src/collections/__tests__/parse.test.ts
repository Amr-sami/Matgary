// Run: npm test -w @matgary/domain
// Spec 06 §7 parse.test.ts + acceptance 5, §5 step 24 (paste hand-off).
import { test } from "node:test";
import assert from "node:assert/strict";

import { SAMPLES, sampleById, type SampleFixture } from "../__fixtures__/samples";
import { autoConfirmGate } from "../match";
import { maskPayerName } from "../normalize";
import { FALLBACK_TEMPLATE_ID, messageText, parseMessage } from "../parse";
import { templateById } from "../templates/index";
import { VODAFONE_CASH_SMS_CREDIT_V1 } from "../templates/vodafone_cash";
import type { CollectionTemplate, ParseInput } from "../types";

const S = (id: string): SampleFixture => {
  const s = sampleById(id);
  assert.ok(s, id);
  return s;
};
const input = (s: SampleFixture, over: Partial<ParseInput> = {}): ParseInput => ({
  channel: s.channel,
  sender: s.sender,
  sourceApp: s.sourceApp,
  body: s.text,
  receivedAt: s.receivedAt,
  ...over,
});
const at = (iso: string) => ({ now: new Date(iso) });

test("acceptance 5: every fixture parses to its §4.14 status, template and fields", () => {
  for (const s of SAMPLES) {
    const r = parseMessage(input(s), at(s.receivedAt));
    const e = s.expect;
    assert.equal(r.status, e.status, `${s.id} status`);
    assert.equal(r.templateId, e.templateId, `${s.id} template`);
    if (e.status !== "parsed") {
      assert.equal(r.fields, null, s.id);
      continue;
    }
    const f = r.fields;
    assert.ok(f, s.id);
    assert.equal(r.confidence, "exact", s.id);
    assert.equal(r.direction, e.direction, `${s.id} direction`);
    const t = templateById(e.templateId as string) as CollectionTemplate;
    assert.equal(r.provider, t.provider, s.id);
    assert.equal(r.rail, t.rail, s.id);
    assert.equal(f.currency, "EGP");
    assert.equal(f.amount, e.amount, `${s.id} amount`);
    assert.equal(f.balanceAfter, e.balanceAfter, `${s.id} balance`);
    assert.equal(f.reference, e.reference, `${s.id} reference`);
    assert.equal(f.receivingHint, e.receivingHint, `${s.id} hint`);
    assert.equal(f.payerPhone, e.payerPhone, `${s.id} payerPhone`);
    assert.equal(maskPayerName(f.payerName), e.payerNameMasked, `${s.id} payer name`);
    assert.equal(f.occurredAt, e.occurredAt, `${s.id} occurredAt`);
    assert.equal(f.occurredAtSource, f.occurredAt === s.receivedAt ? "received" : "message", s.id);
  }
});

test("debits and cash-ins never carry the counterparty or a payer", () => {
  for (const id of ["VF-2", "IP-NBE-3", "IP-NBE-4", "IP-CIB-1-D", "OC-3"]) {
    const r = parseMessage(input(S(id)), at(S(id).receivedAt));
    assert.equal(r.fields?.payerName, null, id);
    assert.equal(r.fields?.payerPhone, null, id);
    assert.ok(!JSON.stringify(r).includes("ABDELAZEEZ"), `${id}: counterparty leaked`);
    assert.ok(!JSON.stringify(r).includes("Home Internet"), `${id}: counterparty leaked`);
  }
});

test("date rule: VF-1's 26-07-27 reads as YY-MM-DD (DD-MM-YY lands in 2027)", () => {
  const s = S("VF-1");
  const r = parseMessage(input(s), at(s.receivedAt));
  assert.equal(r.fields?.occurredAt, "2026-07-27T14:36:00.000Z");
  assert.equal(r.fields?.occurredAtSource, "message");
});

test("date rule: NBE 12-31 23:50 received 2027-01-01T00:10+02:00 resolves to 2026-12-31", () => {
  const body = S("IP-NBE-1").text.replace("يوم 05-04 الساعة 12:25", "يوم 12-31 الساعة 23:50");
  const receivedAt = "2027-01-01T00:10:00+02:00";
  const r = parseMessage({ channel: "android_sms", sender: "AHLY", body, receivedAt }, at("2026-12-31T22:11:00Z"));
  assert.equal(r.status, "parsed");
  assert.equal(r.fields?.occurredAt, "2026-12-31T21:50:00.000Z");
  assert.equal(r.fields?.occurredAtSource, "message");
});

test("date rule: a message time more than 15 min after receivedAt falls back to receivedAt", () => {
  const s = S("IP-NBE-1"); // message 2026-05-04T09:25Z
  const receivedAt = "2026-05-04T09:09:00.000Z"; // 16 min before the message time
  const r = parseMessage(input(s, { receivedAt }), at(receivedAt));
  assert.equal(r.fields?.occurredAt, receivedAt);
  assert.equal(r.fields?.occurredAtSource, "received");
  // 15 min is still inside the window.
  const r2 = parseMessage(input(s, { receivedAt: "2026-05-04T09:10:00.000Z" }), at("2026-05-04T09:10:00Z"));
  assert.equal(r2.fields?.occurredAtSource, "message");
});

test("date rule: a message older than 72 h before receivedAt falls back to receivedAt", () => {
  const s = S("IP-NBE-1");
  const receivedAt = "2026-05-07T09:26:00.000Z"; // 72 h + 1 min after the message time
  const r = parseMessage(input(s, { receivedAt }), at(receivedAt));
  assert.equal(r.fields?.occurredAtSource, "received");
});

test("date rule: QNB 12:05 AM becomes 00:05 (and 12:05 PM stays 12:05)", () => {
  const am = S("IP-QNB-1").text.replace("at 08:34 PM", "at 12:05 AM");
  const r = parseMessage({ channel: "android_sms", sender: "QNB EGYPT", body: am, receivedAt: "2026-05-05T21:06:00Z" }, at("2026-05-05T21:06:00Z"));
  assert.equal(r.fields?.occurredAt, "2026-05-05T21:05:00.000Z"); // 00:05 Cairo (UTC+3, DST)
  const pm = S("IP-QNB-1").text.replace("at 08:34 PM", "at 12:05 PM");
  const r2 = parseMessage({ channel: "android_sms", sender: "QNB EGYPT", body: pm, receivedAt: "2026-05-06T09:06:00Z" }, at("2026-05-06T09:06:00Z"));
  assert.equal(r2.fields?.occurredAt, "2026-05-06T09:05:00.000Z");
});

test("date rule: Cairo winter time is UTC+2 and summer time UTC+3 (DST since 2023)", () => {
  const winter = S("IP-CIB-1").text.replace("15-06-2025 22:49", "15-01-2026 22:49");
  const r = parseMessage({ channel: "android_sms", sender: "cib", body: winter, receivedAt: "2026-01-15T20:50:00Z" }, at("2026-01-15T20:50:00Z"));
  assert.equal(r.fields?.occurredAt, "2026-01-15T20:49:00.000Z");
});

test("date rule: an impossible calendar date falls back to receivedAt", () => {
  const body = S("IP-NBE-1").text.replace("يوم 05-04", "يوم 02-30");
  const receivedAt = "2026-03-02T10:00:00.000Z";
  const r = parseMessage({ channel: "android_sms", sender: "AHLY", body, receivedAt }, at(receivedAt));
  assert.equal(r.fields?.occurredAtSource, "received");
});

test("age: now = receivedAt + 49 h gives too_old; + 47 h still parses", () => {
  const s = S("VF-1");
  const t = new Date(s.receivedAt).getTime();
  assert.equal(parseMessage(input(s), { now: new Date(t + 49 * 3_600_000) }).status, "too_old");
  assert.equal(parseMessage(input(s), { now: new Date(t + 47 * 3_600_000) }).status, "parsed");
  // receivedAt fresh but the message's own time older than 48 h (inside the 72 h window).
  const old = parseMessage(input(S("IP-NBE-1"), { receivedAt: "2026-05-06T12:00:00Z" }), at("2026-05-06T12:00:00Z"));
  assert.equal(old.status, "too_old");
});

test("links: VF-1's vf.eg footer is allowed; an appended look-alike is suspicious; fallback links are all suspicious", () => {
  const s = S("VF-1");
  const ok = parseMessage(input(s), at(s.receivedAt));
  assert.deepEqual(ok.links, ["http://vf.eg/vfcash"]);
  assert.deepEqual(ok.suspiciousLinks, []);
  const bad = parseMessage(input(s, { body: `${s.text} http://vf-eg.co/x` }), at(s.receivedAt));
  assert.equal(bad.templateId, "vodafone_cash.sms.credit.v1");
  assert.deepEqual(bad.suspiciousLinks, ["http://vf-eg.co/x"]);
  const sub = parseMessage(input(s, { body: `${s.text} https://www.pay.vf.eg/a` }), at(s.receivedAt));
  assert.deepEqual(sub.suspiciousLinks, [], "a subdomain of a footer domain is allowed");
  const evil = parseMessage(input(s, { body: `${s.text} vf.eg.evil.com/login` }), at(s.receivedAt));
  assert.deepEqual(evil.suspiciousLinks, ["vf.eg.evil.com/login"]);
  const fb = parseMessage(input(s), { now: new Date(s.receivedAt), templates: [] });
  assert.equal(fb.status, "fallback");
  assert.deepEqual(fb.suspiciousLinks, ["http://vf.eg/vfcash"]);
  // EM-1 carries two spr.ly links, both allowed.
  const em = parseMessage(input(S("EM-1")), at(S("EM-1").receivedAt));
  assert.equal(em.links.length, 2);
  assert.deepEqual(em.suspiciousLinks, []);
});

test("sender: vf-cash matches (case-insensitive); 1234 is numeric and unmatched; paste never matches", () => {
  const s = S("VF-1");
  const a = parseMessage(input(s), at(s.receivedAt));
  assert.equal(a.senderKind, "alphanumeric");
  assert.equal(a.senderMatched, true);
  assert.equal(parseMessage(input(s, { sender: " VF-Cash " }), at(s.receivedAt)).senderMatched, true);
  const n = parseMessage(input(s, { sender: "1234" }), at(s.receivedAt));
  assert.equal(n.templateId, "vodafone_cash.sms.credit.v1", "the body still identifies the provider");
  assert.equal(n.senderKind, "numeric");
  assert.equal(n.senderMatched, false);
  const other = parseMessage(input(s, { sender: "AHLY" }), at(s.receivedAt));
  assert.equal(other.senderMatched, false, "another provider's sender id");
  const paste = parseMessage(input(s, { channel: "manual_paste", sender: "vf-cash" }), at(s.receivedAt));
  assert.equal(paste.status, "parsed");
  assert.equal(paste.senderMatched, false);
  const nbe = parseMessage(input(S("IP-NBE-1"), { sender: "BANK-ALAHLY" }), at(S("IP-NBE-1").receivedAt));
  assert.equal(nbe.senderMatched, true, "D06-b: NBE seen as BanK-AlAhly / Bank-Alahly");
});

test("notification channels: senderKind app; senderMatched only for a listed package", () => {
  const s = S("VF-1");
  const notif: CollectionTemplate = {
    ...VODAFONE_CASH_SMS_CREDIT_V1,
    id: "vodafone_cash.notification.credit.v1",
    channel: "notification",
    senderIds: [],
    packages: ["com.emeint.android.myservices"],
  };
  const opts = { now: new Date(s.receivedAt), templates: [notif] };
  const yes = parseMessage(input(s, { channel: "android_notification", sender: null, sourceApp: "com.emeint.android.myservices" }), opts);
  assert.equal(yes.senderKind, "app");
  assert.equal(yes.senderMatched, true);
  const no = parseMessage(input(s, { channel: "android_notification", sender: null, sourceApp: "com.evil.app" }), opts);
  assert.equal(no.senderMatched, false);
  const ios = parseMessage(input(s, { channel: "ios_notification", sender: null, sourceApp: "ios.unknown" }), opts);
  assert.equal(ios.senderMatched, false, "03 §D.7: ios.unknown is on no allowlist");
});

test("messageText joins the non-empty title, subtitle and body with newlines", () => {
  assert.equal(messageText({ title: "InstaPay", subtitle: "", body: "IPN" }), "InstaPay\nIPN");
  assert.equal(messageText({ title: null, subtitle: "x", body: "y" }), "x\ny");
  assert.equal(messageText({ body: "only" }), "only");
});

test("fallback (templates disabled): VF-1 → 2700.00, OC-1 → unknown_format, VF-2 → not_credit, IP-NBE-1 → 5000.00", () => {
  const none = (id: string) => parseMessage(input(S(id)), { now: new Date(S(id).receivedAt), templates: [] });
  const vf1 = none("VF-1");
  assert.equal(vf1.status, "fallback");
  assert.equal(vf1.templateId, FALLBACK_TEMPLATE_ID);
  assert.equal(vf1.confidence, "fallback");
  assert.equal(vf1.direction, "credit");
  assert.equal(vf1.provider, null);
  assert.equal(vf1.senderMatched, false);
  assert.deepEqual(
    { ...vf1.fields },
    {
      amount: "2700.00",
      currency: "EGP",
      payerPhone: null,
      payerName: null,
      balanceAfter: null,
      reference: null,
      receivingHint: null,
      occurredAt: S("VF-1").receivedAt,
      occurredAtSource: "received",
    },
  );
  assert.equal(none("OC-1").status, "unknown_format", "its marketing tail '100 جنيه' is a second amount");
  assert.equal(none("VF-2").status, "not_credit");
  const nbe = none("IP-NBE-1");
  assert.equal(nbe.status, "fallback");
  assert.equal(nbe.fields?.amount, "5000.00");
  // a credit word AND a debit word → unknown_format (kept for learning)
  assert.equal(
    parseMessage({ channel: "android_sms", body: "تم استلام مبلغ 50 جنيه وتم خصم مبلغ 5 جنيه", receivedAt: S("VF-1").receivedAt }, at(S("VF-1").receivedAt)).status,
    "unknown_format",
  );
  // Latin credit words are whole words; "sent" as a whole word is a debit word
  const latin = (body: string) =>
    parseMessage({ channel: "android_sms", body, receivedAt: S("VF-1").receivedAt }, at(S("VF-1").receivedAt)).status;
  assert.equal(latin("Your account was credited with EGP 75.00"), "fallback");
  assert.equal(latin("Transfer received EGP 75.00, sent EGP 5.00"), "unknown_format");
  assert.equal(latin("Unreceivedx EGP 75.00"), "not_credit");
  assert.equal(latin("Transfer received with no amount"), "unknown_format");
});

test("a zero amount gives not_credit (template hit and fallback)", () => {
  const s = S("VF-1");
  const zero = s.text.replace("2700.00", "0.00");
  assert.equal(parseMessage(input(s, { body: zero }), at(s.receivedAt)).status, "not_credit");
  assert.equal(parseMessage(input(s, { body: zero }), { now: new Date(s.receivedAt), templates: [] }).status, "not_credit");
  assert.equal(
    parseMessage({ channel: "android_sms", body: "تم استلام مبلغ 0.00 جنيه", receivedAt: s.receivedAt }, at(s.receivedAt)).status,
    "not_credit",
  );
});

test("an OTP is dropped before anything else, with every field null", () => {
  const r = parseMessage({ channel: "ios_sms", sender: "AHLY", body: "تم استلام مبلغ 50 جنيه. رمز التحقق 1234", receivedAt: "2026-05-04T09:26:00Z" }, at("2026-05-04T09:26:00Z"));
  assert.equal(r.status, "otp");
  assert.equal(r.templateId, null);
  assert.equal(r.fields, null);
  assert.deepEqual(r.links, []);
});

test("Arabic-Indic digits, bidi marks and tatweel in the raw text still parse (OC-2, a marked-up VF-1)", () => {
  const s = S("VF-1");
  const marked = "‏" + s.text.replace("رصيدك", "رصـيدك").replace("2700.00", "٢٧٠٠٫٠٠");
  const r = parseMessage(input(s, { body: marked }), at(s.receivedAt));
  assert.equal(r.templateId, "vodafone_cash.sms.credit.v1");
  assert.equal(r.fields?.amount, "2700.00");
});

test("budget: 2,000-character adversarial bodies parse in < 50 ms", () => {
  const bodies = [
    "تم استلام مبلغ 1 جنيه من ".repeat(100).slice(0, 2000),
    ("تم اضافه تحويل لحظي لحسابكم رقم 0150 بمبلغ 5 جم من " + "رقم مرجعي 123456789012 يوم ".repeat(80)).slice(0, 2000),
    ("يرجى العلم انه تم تنفيذ تحويل لحظي بمبلغ 1 جم إلى حسابك المنتهي بـ ****0018 من " + "A ".repeat(1000)).slice(0, 2000),
    "1".repeat(2000),
    ("IPN transfer received with amount of EGP " + "1,".repeat(990)).slice(0, 2000),
  ];
  for (const body of bodies) {
    assert.equal(body.length, 2000);
    parseMessage({ channel: "android_sms", body, receivedAt: "2026-05-04T09:26:00Z" }, at("2026-05-04T09:26:00Z")); // warm
    const t0 = performance.now();
    parseMessage({ channel: "android_sms", body, receivedAt: "2026-05-04T09:26:00Z" }, at("2026-05-04T09:26:00Z"));
    const dt = performance.now() - t0;
    assert.ok(dt < 50, `${dt.toFixed(1)} ms for ${body.slice(0, 20)}…`);
  }
});

test("step 24 hand-off: every §4.14 text pasted gives the same status, senderMatched false, gate manual_source", () => {
  for (const s of SAMPLES) {
    const r = parseMessage({ channel: "manual_paste", body: s.text, receivedAt: s.receivedAt }, at(s.receivedAt));
    assert.equal(r.status, s.expect.status, s.id);
    assert.equal(r.templateId, s.expect.templateId, s.id);
    assert.equal(r.senderMatched, false, s.id);
    if (r.status !== "parsed" || !r.fields) continue;
    const g = autoConfirmGate({
      autoConfirmFeature: true,
      account: { autoConfirmEnabled: true, reviewThreshold: "100000" },
      template: templateById(r.templateId as string),
      channel: "manual_paste",
      senderKind: r.senderKind,
      senderMatched: r.senderMatched,
      device: { live: true, channels: ["manual_paste"] },
      amount: r.fields.amount,
      occurredAt: r.fields.occurredAt,
      reference: r.fields.reference,
      suspiciousLinks: r.suspiciousLinks,
      isTest: false,
      balance: "pass",
      now: new Date(s.receivedAt),
    });
    assert.equal(g.pass, false, s.id);
    assert.equal(g.reason, "manual_source", s.id);
  }
});
