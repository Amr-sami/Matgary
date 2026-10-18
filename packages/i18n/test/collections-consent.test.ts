// Doc 15 spec 14 §7: the automatic-confirmation consent text is versioned legal text, and the
// privacy / terms sections that describe collections must stay numbered, paired and honest.
//
//   node --test --experimental-strip-types packages/i18n/test/collections-consent.test.ts
//
// A consent record (`collection_ingest_devices.consent_version`, spec 07) names the exact text the owner
// agreed to. So any change to `mobile.collections.consent` in EITHER language needs a new `version`
// and a new PINS entry — a typo fix included. The git commit that adds a version is the archive of
// its text. The hash is taken over a canonical (sorted-key) JSON of both locales, so reordering keys
// in the dictionary file is not a text change, while any change to a leaf is.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
type Dict = Record<string, unknown>;
const load = (l: string): Dict => JSON.parse(readFileSync(join(src, `${l}.json`), "utf8")) as Dict;
const at = (d: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Dict)[k] : undefined), d);

/** version → sha256 of canonical({ar, en}). Never edit a pinned value; add a new version instead. */
const PINS: Record<string, string> = {
  "2026-10-01": "d0994ab53771444a28160ad6181784c34028ad1a7fc66c0f81b3e56e123320e7",
};

const arDict = load("ar"), enDict = load("en");
const consentAr = at(arDict, "mobile.collections.consent") as Dict | undefined;
const consentEn = at(enDict, "mobile.collections.consent") as Dict | undefined;

/** Leaf path → string, in document order. */
function leaves(node: unknown, prefix = "", out = new Map<string, string>()): Map<string, string> {
  if (typeof node === "string") out.set(prefix, node);
  else if (Array.isArray(node)) node.forEach((v, i) => leaves(v, `${prefix}[${i}]`, out));
  else if (node && typeof node === "object")
    for (const [k, v] of Object.entries(node as Dict)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as Dict).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Dict)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

type Section = { title: string; body: string };
const sections = (d: Dict, doc: "privacy" | "terms") => at(d, `marketing.${doc}.sections`) as Section[];
const privAr = sections(arDict, "privacy"), privEn = sections(enDict, "privacy");
const termsAr = sections(arDict, "terms"), termsEn = sections(enDict, "terms");
const find = (secs: Section[], needle: string) => secs.find((s) => s.title.includes(needle) || s.body.includes(needle));

// The 21 leaves and the render order of 14 §4.2 / 03 §B.9 (09's ConsentScreen maps them 1:1).
const LEAVES = [
  "version", "versionLabel", "title",
  "ios.lead", "ios.reads", "ios.sends", "ios.key",
  "android.lead", "android.reads", "android.sends", "android.key",
  "common.neverSends", "common.purpose", "common.payers", "common.retention", "common.control", "common.law", "common.statement",
  "privacyLink", "agree", "decline",
];

// 02 §4.9 "Never write" (en / ar).
const FORBIDDEN = [
  "accept payments", "payment gateway", "process payments", "collect online", "guaranteed",
  "verified by your bank", "refund the transfer", "reverse the transfer",
  "بوابة دفع", "استقبال المدفوعات", "دفع إلكتروني مضمون", "استرجاع التحويل",
];

test("T-consent-1: ar and en mobile.collections.consent have the same 21 leaf paths", () => {
  assert.ok(consentAr && consentEn, "mobile.collections.consent missing in a dictionary");
  const a = [...leaves(consentAr).keys()].sort(), e = [...leaves(consentEn).keys()].sort();
  assert.deepEqual(a, e);
  assert.deepEqual(a, [...LEAVES].sort());
  for (const [k, v] of [...leaves(consentAr), ...leaves(consentEn)]) assert.ok(v.trim().length > 0, `empty leaf ${k}`);
});

test("T-consent-2: version is equal in both files and matches 07's consentVersion zod", () => {
  assert.equal(consentAr?.version, consentEn?.version);
  assert.match(String(consentAr?.version), /^[A-Za-z0-9._-]{1,32}$/);
});

test("T-consent-3: the text of this version is pinned (change a leaf → bump version + add a PINS entry)", () => {
  const version = String(consentAr?.version);
  const actual = createHash("sha256").update(canonical({ ar: consentAr, en: consentEn })).digest("hex");
  const pinned = PINS[version];
  assert.ok(
    pinned === actual,
    pinned === undefined
      ? `consent version ${version} has no pin: add  "${version}": "${actual}"  to PINS`
      : `consent text changed but version ${version} did not: bump version (both files) and pin the new one; actual sha256 = ${actual}`,
  );
});

test("T-consent-4: no consent leaf carries a {placeholder} (09 renders with plain t(key))", () => {
  for (const [k, v] of [...leaves(consentAr), ...leaves(consentEn)]) assert.ok(!v.includes("{"), `placeholder in ${k}`);
});

test("T-consent-5: every Arabic consent leaf except version is Arabic text (the Arabic is the legal text)", () => {
  for (const [k, v] of leaves(consentAr)) {
    if (k === "version") continue;
    assert.match(v, /[؀-ۿ]/, `ar ${k} has no Arabic letter`);
  }
});

test("T-consent-6: the required disclosures are present (OTP, the law, retention, unlink, SMS, money sent)", () => {
  const ar = [...leaves(consentAr).values()].join("\n"), en = [...leaves(consentEn).values()].join("\n");
  for (const s of ["OTP", "151", "7 أيام", "إلغاء الربط"]) assert.ok(ar.includes(s), `ar lacks ${s}`);
  assert.ok(String(at(consentAr, "android.reads")).includes("SMS"), "ar android.reads must say SMS is never read");
  for (const s of ["OTP", "151", "7 days", "Unlink", "received or sent"]) assert.ok(en.includes(s), `en lacks ${s}`);
});

test("T-consent-7: no forbidden phrase (02 §4.9) in the consent, the collections privacy sections or terms §13", () => {
  const texts: string[] = [...leaves(consentAr).values(), ...leaves(consentEn).values()];
  for (const needle of ["حسابات الاستلام", "Receiving accounts", "المُمرَّرة", "Forwarded bank and wallet messages"]) {
    for (const s of [find(privAr, needle), find(privEn, needle)]) if (s) texts.push(s.title, s.body);
  }
  for (const s of [termsAr[12], termsEn[12]]) if (s) texts.push(s.title, s.body);
  const hay = texts.join("\n").toLowerCase();
  for (const f of FORBIDDEN) assert.ok(!hay.includes(f.toLowerCase()), `forbidden phrase "${f}"`);
});

test("T-privacy-1: privacy sections pair up, titles are unique and numbered 1…N without gaps", () => {
  assert.equal(privAr.length, privEn.length);
  for (const secs of [privAr, privEn]) {
    assert.equal(new Set(secs.map((s) => s.title)).size, secs.length, "duplicate title (the web keys on it)");
    secs.forEach((s, i) => assert.ok(s.title.startsWith(`${i + 1}. `), `section ${i}: "${s.title}"`));
  }
});

test("T-privacy-2: §12 receiving accounts (M1) exists; from 14 sections, §13 forwarded messages (M2) too", () => {
  const ar12 = find(privAr, "حسابات الاستلام"), en12 = find(privEn, "Receiving accounts");
  assert.ok(ar12 && en12, "privacy §12 missing");
  assert.equal(privAr.indexOf(ar12!), privEn.indexOf(en12!), "§12 at a different index in ar and en");
  assert.ok(privAr.at(-1)!.title.includes("التحديثات") && privEn.at(-1)!.title.includes("Updates"), "Updates must stay last");
  if (privAr.length >= 14) {
    assert.ok(find(privAr, "المُمرَّرة") && find(privEn, "Forwarded bank and wallet messages"), "privacy §13 missing");
  }
});

test("T-terms-1: terms sections pair up and are numbered 1…N without gaps", () => {
  assert.equal(termsAr.length, termsEn.length);
  for (const secs of [termsAr, termsEn]) secs.forEach((s, i) => assert.ok(s.title.startsWith(`${i + 1}. `), `terms ${i}: "${s.title}"`));
});

test(
  "T-terms-2: terms end with §13, the processor clause (14 §4.4)",
  { skip: termsAr.length < 13 ? "terms §13 lands with spec 14 step 4 (README §3 order 16)" : false },
  () => {
    assert.ok(termsAr.at(-1)!.title.startsWith("13. ") && termsEn.at(-1)!.title.startsWith("13. "));
    assert.ok(termsEn.at(-1)!.title.includes("on your behalf"));
    assert.ok(termsAr.at(-1)!.title.includes("نيابةً عنك"));
  },
);

// Terms §11 promises 14 days' notice of a material change, so the lead names the day §13 takes effect,
// at least 14 days after "Last updated". Both dates are a placeholder (UNVERIFIED) until the text is live
// in production: whoever deploys it sets "Last updated" to the deploy day and the effective day to ≥ 14
// days later, in both files (spec 14 step 4 "As landed"); this test then keeps the gap and the locales honest.
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
function leadDates(lead: string, months: string[]): number[] {
  const re = new RegExp(`(\\d{1,2}) (${months.join("|")}) (\\d{4})`, "g");
  return [...lead.matchAll(re)].map((m) => Date.UTC(Number(m[3]), months.indexOf(m[2]), Number(m[1])));
}
test(
  "T-terms-3: the terms lead gives §13's effective date, ≥ 14 days after the update, the same in ar and en",
  { skip: termsAr.length < 13 ? "terms §13 lands with spec 14 step 4 (README §3 order 16)" : false },
  () => {
    const leadAr = String(at(arDict, "marketing.terms.lead")), leadEn = String(at(enDict, "marketing.terms.lead"));
    assert.match(leadEn, /^Last updated: .+\. Section 13 takes effect on .+\.$/);
    assert.match(leadAr, /^آخر تحديث: .+\. يسري البند 13 اعتبارًا من .+\.$/);
    const en = leadDates(leadEn, MONTHS_EN), ar = leadDates(leadAr, MONTHS_AR);
    assert.equal(en.length, 2, `en lead needs two dates: "${leadEn}"`);
    assert.deepEqual(ar, en, "ar and en terms leads name different dates");
    assert.ok(en[1] - en[0] >= 14 * 86_400_000, "§13 must take effect at least 14 days after the update (terms §11)");
  },
);

test(
  "T-privacy-3: from 14 sections, §13 forwarded messages sits right after §12 receiving accounts, in both",
  { skip: privAr.length < 14 ? "privacy §13 lands with spec 14 step 5 (README §3 order 16)" : false },
  () => {
    for (const [secs, s12, s13] of [[privAr, "حسابات الاستلام", "المُمرَّرة"], [privEn, "Receiving accounts", "Forwarded bank and wallet messages"]] as const) {
      const i12 = secs.indexOf(find(secs, s12)!), i13 = secs.indexOf(find(secs, s13)!);
      assert.equal(i12, 11, "§12 must stay at index 11");
      assert.equal(i13, 12, "§13 must be at index 12, before Updates");
    }
  },
);
