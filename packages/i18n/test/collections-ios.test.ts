// Doc 15 spec 10 §7.1: the iOS automation copy `mobile.collections.ios.*` (shortcut steps; M3 adds the
// App Intent strings under `intent.*` / `upgrade.*`).
//
//   node --test --experimental-strip-types packages/i18n/test/collections-ios.test.ts
//
// - ar and en have the same leaf set under `mobile.collections.ios`;
// - `shortcutName` is byte-identical Arabic in both files (D10-1: a shortcut has ONE installed name, and
//   `shortcuts://run-shortcut?name=` / `open-shortcut?name=` match it exactly);
// - each key has the same `{placeholder}` set in both languages;
// - every `intent.*` value is free of `"`, `\` and newlines: the M3 config plugin writes them into
//   `Localizable.strings`, whose Expo writer does not escape (10 §4.11 step 1, §8).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
type Dict = Record<string, unknown>;
const load = (l: string): Dict => JSON.parse(readFileSync(join(src, `${l}.json`), "utf8")) as Dict;
const at = (d: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Dict)[k] : undefined), d);

function leaves(d: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (d && typeof d === "object") {
    for (const [k, v] of Object.entries(d as Dict)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "string") out.set(p, v);
      else for (const [kk, vv] of leaves(v, p)) out.set(kk, vv);
    }
  }
  return out;
}

const iosAr = at(load("ar"), "mobile.collections.ios");
const iosEn = at(load("en"), "mobile.collections.ios");
const ar = leaves(iosAr);
const en = leaves(iosEn);
const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

test("mobile.collections.ios exists in both dictionaries with the M2 rows", () => {
  assert.ok(iosAr && typeof iosAr === "object", "ar: mobile.collections.ios missing");
  assert.ok(iosEn && typeof iosEn === "object", "en: mobile.collections.ios missing");
  // The M2 skeleton of 10 §4.13 (38 rows); M3 adds intent.* and upgrade.* on top.
  assert.ok(ar.size >= 38, `ar has ${ar.size} leaves`);
  for (const k of ["shortcutName", "shortcutNameGloss", "install.http.s1", "enable.ios27.s1", "enable.legacy.s1",
    "enable.legacy27.s1", "enable.alwaysAllow.http", "runningNote", "troubleshoot.common.s1"]) {
    assert.ok(ar.has(k), `ar: ${k}`);
  }
});

test("identical leaf sets in ar and en", () => {
  assert.deepEqual([...ar.keys()].sort(), [...en.keys()].sort());
});

test("shortcutName is byte-identical Arabic in both files", () => {
  assert.equal(ar.get("shortcutName"), "ستورو — تأكيد التحويلات");
  assert.equal(en.get("shortcutName"), ar.get("shortcutName"));
});

test("no empty value, and equal {placeholder} sets per key", () => {
  for (const [k, v] of ar) {
    assert.ok(v.trim().length > 0, `ar: ${k} empty`);
    const e = en.get(k) ?? "";
    assert.ok(e.trim().length > 0, `en: ${k} empty`);
    assert.deepEqual(placeholders(v), placeholders(e), `placeholders differ: ${k}`);
  }
});

// M3 (10 §5 step 11): the App Intent strings and the HTTP → intent upgrade sheet. The intent's Swift
// `LocalizedStringResource` keys are `collections_intent_<snake_case(name)>` (10 §4.11 step 1), so
// every name below must exist, and the mapping must not collide.
const M3_INTENT = ["title", "description", "paramText", "paramTitle", "paramSubtitle", "paramSender", "paramSource",
  "paramReceivedAt", "dialogSent", "dialogQueued", "dialogNotLinked", "dialogTest", "dialogTestFailed", "dialogSkipped"];
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

test("M3 rows: intent.* (14) and upgrade.* (3) exist, and the .strings keys are unique", () => {
  for (const n of M3_INTENT) assert.ok(ar.has(`intent.${n}`), `ar: intent.${n}`);
  for (const n of ["title", "body", "action"]) assert.ok(ar.has(`upgrade.${n}`), `ar: upgrade.${n}`);
  const intentNames = [...ar.keys()].filter((k) => k.startsWith("intent.")).map((k) => k.slice("intent.".length));
  assert.deepEqual(intentNames.sort(), [...M3_INTENT].sort(), "no extra intent.* leaf (the Swift file names each one)");
  const keys = intentNames.map((n) => `collections_intent_${snake(n)}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("collections_intent_param_received_at"));
  assert.ok(keys.includes("collections_intent_dialog_test_failed"));
});

test("every intent.* value is .strings-safe (no double quote, backslash or newline)", () => {
  for (const [loc, m] of [["ar", ar], ["en", en]] as const) {
    for (const [k, v] of m) {
      if (!k.startsWith("intent.")) continue;
      assert.ok(!/["\\\n\r]/.test(v), `${loc}: ${k} = ${JSON.stringify(v)}`);
    }
  }
});
