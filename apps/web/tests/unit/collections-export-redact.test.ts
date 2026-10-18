// Spec 15 §7 — the allowlist redaction of scripts/lib/collections-redact.ts
// (§4.10.1–4.10.2). Pure: no DB, no network.
//
// applyFillsLocal stands in for 06's applyFills until order 18 lands (see the
// module header); the round-trip rule is 06's fixtures.test.ts rule.

import { describe, expect, it } from "vitest";
import {
  applyFillsLocal,
  buildVocabulary,
  redactSample,
  type RedactInput,
} from "@/scripts/lib/collections-redact";

// = SAMPLES["VF-1"].text (06 §4.14): the published VF-1 with its fills applied.
const VF1_TEXT =
  "تم استلام مبلغ 2700.00 جنيه من رقم 01127777705 المسجل بإسم محمد احمد علي على رقم محفظتك  01007777765.\n" +
  "رصيدك الحالي: 2724.51 جنيه\n" +
  "تاريخ العملية: 17:36 26-07-27\n" +
  "رقم العملية: 022177777777\n" +
  "تابع كل مصروفاتك من تاريخ المعاملات على أبلكيشن أنا فودافون http://vf.eg/vfcash";

// = SAMPLES["IP-CIB-1"].text, with the amount written grouped (64,500.00).
const CIB_NAME = "AHMED MOHAMED ABDELRAHM"; // the 23-char Latin fill
const CIB_TEXT =
  "يرجى العلم انه تم تنفيذ تحويل لحظي بمبلغ 64,500.00 جم إلى حسابك المنتهي بـ ********0018 من " +
  CIB_NAME +
  " برقم مرجعي 9951576c بتاريخ 15-06-2025 22:49 للمزيد، برجاء الاتصال بـ 19666";

const vocab = buildVocabulary();
const sms = (body: string, extra: Partial<RedactInput> = {}): RedactInput => ({
  body,
  sender: "vf-cash",
  senderKind: "alphanumeric",
  ...extra,
});

describe("collections-redact — VF-1 filled text", () => {
  const r = redactSample(sms(VF1_TEXT), vocab);

  it("masks the payer phone, the wallet and the reference to their last 4", () => {
    expect(r.body).toContain("xxxxxxx7705");
    expect(r.body).toContain("xxxxxxx7765");
    expect(r.body).toContain("xxxxxxxx7777");
    expect(r.body).not.toContain("01127777705");
    expect(r.body).not.toContain("01007777765");
    expect(r.body).not.toContain("022177777777");
  });

  it("keeps the amount, the balance, the time, the date and the footer URL", () => {
    for (const kept of ["2700.00", "2724.51", "17:36", "26-07-27", "http://vf.eg/vfcash"]) {
      expect(r.body).toContain(kept);
    }
  });

  it("masks the three name words as three distinct <Wn>", () => {
    for (const name of ["محمد", "احمد"]) expect(r.body).not.toContain(name);
    expect(r.body).not.toMatch(/(^|\s)علي(\s|$)/);
    const m = r.body.match(/بإسم (<W\d+>) (<W\d+>) (<W\d+>)/);
    expect(m).not.toBeNull();
    expect(new Set(m!.slice(1, 4)).size).toBe(3);
    expect(r.redactions).toEqual(expect.arrayContaining([{ kind: "digits", count: 3 }]));
  });

  it("keeps an alphanumeric sender", () => {
    expect(r.sender).toBe("vf-cash");
  });
});

describe("collections-redact — IP-CIB-1", () => {
  const r = redactSample(sms(CIB_TEXT, { sender: "cib" }), vocab);

  it("masks the hex reference, keeps the bank mask and the grouped amount", () => {
    expect(r.body).toContain("xxxx576c");
    expect(r.body).not.toContain("9951576c");
    expect(r.body).toContain("********0018");
    expect(r.body).toContain("64,500.00");
    expect(r.redactions).toEqual(expect.arrayContaining([{ kind: "hex", count: 1 }]));
  });

  it("masks the 23-char Latin name word by word", () => {
    for (const w of CIB_NAME.split(" ")) expect(r.body).not.toContain(w);
    expect(r.body).toMatch(/من <W1> <W2> <W3> برقم/);
  });
});

describe("collections-redact — digits, dates, URLs, senders", () => {
  it("normalises Arabic-Indic digits and masks the run", () => {
    expect(redactSample(sms("رقم ٠١٠١٢٣٤٥٦٧٨"), vocab).body).toBe("رقم xxxxxxx5678");
  });

  it("masks a grouped phone as one run", () => {
    const r = redactSample(sms("رقم 010 1234 5678"), vocab);
    expect(r.body).toBe("رقم xxx xxxx 5678");
    expect(r.redactions).toEqual([{ kind: "digits", count: 1 }]);
  });

  it("does not treat a date and a time as digits", () => {
    expect(redactSample(sms("تاريخ 2026-05-04 09:25"), vocab).body).toBe("تاريخ 2026-05-04 09:25");
  });

  it("replaces a URL outside the footer allowlist", () => {
    const r = redactSample(sms("رقم https://evil.example/x"), vocab);
    expect(r.body).toBe("رقم <URL>");
    expect(r.redactions).toEqual([{ kind: "url", count: 1 }]);
  });

  it("masks a numeric sender and keeps an alphanumeric one", () => {
    expect(redactSample(sms("رقم", { sender: "01012345678", senderKind: "numeric" }), vocab).sender).toBe("xxxxxxx5678");
    expect(redactSample(sms("رقم", { sender: "vf-cash", senderKind: "alphanumeric" }), vocab).sender).toBe("vf-cash");
  });
});

describe("collections-redact — allowWords, determinism, fills, vocabulary, budget", () => {
  it("keeps a word the owner confirmed (allowWords)", () => {
    const body = "تم استلام حوالة بمبلغ 50.00 جنيه";
    expect(redactSample(sms(body), vocab).body).toContain("<W1>");
    const r = redactSample(sms(body), vocab, ["حوالة"]);
    expect(r.body).toContain("حوالة");
    expect(r.unknownWords).toBe(0);
  });

  it("gives the same word the same <Wn> and two runs the same output", () => {
    const input = sms("من سامح الي سامح و كريم", { title: "سامح" });
    const a = redactSample(input, vocab);
    const b = redactSample(input, buildVocabulary());
    expect(a).toEqual(b);
    expect(a.title).toBe("<W1>");
    expect(a.body).toBe("من <W1> الي <W1> و <W2>");
    expect(a.unknownWords).toBe(2);
  });

  it("fills round-trip: no < placeholder and no x{5,} run (06 fixtures rule)", () => {
    for (const text of [VF1_TEXT, CIB_TEXT, "رقم 010 1234 5678 https://evil.example/x"]) {
      const r = redactSample(sms(text), vocab);
      const filled = applyFillsLocal(r.body, r.fills);
      expect(filled).not.toContain("<");
      expect(filled).not.toMatch(/x{5,}/);
    }
  });

  it("builds a vocabulary with the structural words and without names", () => {
    expect(vocab.has("استلام")).toBe(true);
    expect(vocab.has("egp")).toBe(true);
    expect(vocab.has("محمد")).toBe(false);
    expect(vocab.has("ahmed")).toBe(false);
  });

  it("redacts a 2,000-char adversarial body in < 50 ms", () => {
    const body = "تم استلام مبلغ 1 جنيه من 0112345678 سامح ab12cd34 ".repeat(40).slice(0, 2000);
    redactSample(sms(body), vocab); // warm the regex caches
    const t0 = performance.now();
    const r = redactSample(sms(body), vocab);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(r.body).not.toMatch(/\d{7,}/);
  });
});
