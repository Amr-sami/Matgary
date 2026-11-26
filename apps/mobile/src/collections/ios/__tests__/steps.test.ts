/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/collections/ios/__tests__/steps.test.ts
 *
 * `steps.ts` is import-free. Cases: doc 15 spec 10 §7.1 (steps.test.ts row) —
 * the shortcut name equals both dictionaries; every phase × mode × variant ×
 * iOS {17, 26, 27} returns ≥ 1 step and only keys that resolve in ar AND en;
 * legacy on 27 never returns the iOS 17–26 list; ios27 never returns
 * `runningNote`; every `{name}` / `{keyword}` placeholder has a param.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import * as s from "../steps.ts";

const here = dirname(fileURLToPath(import.meta.url));
const i18nSrc = join(here, "../../../../../../packages/i18n/src");
const dicts = {
  ar: JSON.parse(readFileSync(join(i18nSrc, "ar.json"), "utf8")),
  en: JSON.parse(readFileSync(join(i18nSrc, "en.json"), "utf8")),
} as const;

function lookup(d: unknown, key: string): string | undefined {
  let node: unknown = d;
  for (const seg of key.split(".")) {
    node = node && typeof node === "object" ? (node as Record<string, unknown>)[seg] : undefined;
  }
  return typeof node === "string" ? node : undefined;
}

const PHASES = ["install", "enable", "troubleshoot"] as const;
const MODES = ["http", "intent"] as const;
const VARIANTS = ["ios27", "legacy"] as const;
const MAJORS = [17, 26, 27];

function* everyCombination() {
  for (const phase of PHASES)
    for (const mode of MODES)
      for (const variant of VARIANTS)
        for (const iosMajor of MAJORS) yield { phase, mode, variant, iosMajor };
}

test("IOS_SHORTCUT_NAME equals mobile.collections.ios.shortcutName in ar and in en (D10-1)", () => {
  assert.equal(lookup(dicts.ar, "mobile.collections.ios.shortcutName"), s.IOS_SHORTCUT_NAME);
  assert.equal(lookup(dicts.en, "mobile.collections.ios.shortcutName"), s.IOS_SHORTCUT_NAME);
});

test("every combination returns ≥ 1 step and only keys that resolve in both dictionaries", () => {
  let n = 0;
  for (const c of everyCombination()) {
    const steps = s.iosStepKeys(c);
    assert.ok(steps.length >= 1, JSON.stringify(c));
    for (const st of steps) {
      n++;
      assert.ok(st.key.startsWith("mobile.collections.ios."), st.key);
      for (const loc of ["ar", "en"] as const) {
        const v = lookup(dicts[loc], st.key);
        assert.ok(typeof v === "string" && v.length > 0, `${loc}: ${st.key} (${JSON.stringify(c)})`);
      }
    }
  }
  assert.ok(n > 100, `walked ${n} steps`);
});

test("every {name}/{keyword} placeholder in a returned key's text has a param, and no param is unused", () => {
  for (const c of everyCombination()) {
    for (const st of s.iosStepKeys(c)) {
      for (const loc of ["ar", "en"] as const) {
        const text = lookup(dicts[loc], st.key) ?? "";
        const used = new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
        const given = new Set(Object.keys(st.params ?? {}));
        assert.deepEqual([...used].sort(), [...given].sort(), `${loc}: ${st.key}`);
      }
    }
  }
});

test("legacy on iOS 27 returns enable.legacy27.* and never enable.legacy.*; on 17 and 26 the reverse", () => {
  for (const mode of MODES) {
    const on27 = s.iosStepKeys({ phase: "enable", mode, variant: "legacy", iosMajor: 27 }).map((x) => x.key);
    assert.ok(on27.some((k) => k.includes(".enable.legacy27.")));
    assert.ok(!on27.some((k) => k.includes(".enable.legacy.")));
    for (const iosMajor of [17, 26]) {
      const keys = s.iosStepKeys({ phase: "enable", mode, variant: "legacy", iosMajor }).map((x) => x.key);
      assert.ok(keys.some((k) => k.includes(".enable.legacy.")));
      assert.ok(!keys.some((k) => k.includes(".enable.legacy27.")));
    }
  }
});

test("runningNote: only legacy below iOS 27; ios27 never returns it", () => {
  for (const c of everyCombination()) {
    const has = s.iosStepKeys(c).some((x) => x.key === "mobile.collections.ios.runningNote");
    const expected = c.phase === "enable" && c.variant === "legacy" && c.iosMajor < 27;
    assert.equal(has, expected, JSON.stringify(c));
  }
});

test("exact lists (10 §4.13 selection)", () => {
  const k = (i: Parameters<typeof s.iosStepKeys>[0]) => s.iosStepKeys(i).map((x) => x.key.replace("mobile.collections.ios.", ""));
  assert.deepEqual(k({ phase: "install", mode: "http", variant: "legacy", iosMajor: 26 }), [
    "install.http.s1", "install.http.s2", "install.http.s3", "install.http.s4",
  ]);
  assert.deepEqual(k({ phase: "install", mode: "intent", variant: "ios27", iosMajor: 27 }), [
    "install.intent.s1", "install.intent.s2", "install.intent.s3",
  ]);
  assert.deepEqual(k({ phase: "enable", mode: "http", variant: "ios27", iosMajor: 27 }), [
    "enable.ios27.s1", "enable.ios27.s2", "enable.ios27.s3", "enable.ios27.s4",
    "enable.alwaysAllow.http", "enable.optionalNotification.s1", "enable.optionalNotification.s2",
  ]);
  assert.deepEqual(k({ phase: "enable", mode: "http", variant: "legacy", iosMajor: 26 }), [
    "enable.legacy.s1", "enable.legacy.s2", "enable.legacy.s3", "enable.legacy.s4", "enable.legacy.s5",
    "enable.legacy.s6", "enable.alwaysAllow.http", "runningNote",
  ]);
  assert.deepEqual(k({ phase: "enable", mode: "intent", variant: "legacy", iosMajor: 27 }), [
    "enable.legacy27.s1", "enable.legacy27.s2", "enable.legacy27.s3", "enable.legacy27.s4", "enable.alwaysAllow.intent",
  ]);
  assert.deepEqual(k({ phase: "troubleshoot", mode: "http", variant: "legacy", iosMajor: 26 }), [
    "troubleshoot.common.s1", "troubleshoot.common.s2", "troubleshoot.common.s3", "troubleshoot.common.s4",
    "troubleshoot.common.s5", "troubleshoot.legacy.s1", "troubleshoot.http.s1",
  ]);
  assert.deepEqual(k({ phase: "troubleshoot", mode: "intent", variant: "ios27", iosMajor: 27 }), [
    "troubleshoot.common.s1", "troubleshoot.common.s2", "troubleshoot.common.s3", "troubleshoot.common.s4",
    "troubleshoot.common.s5", "troubleshoot.ios27.s1", "troubleshoot.intent.s1", "troubleshoot.intent.s2",
  ]);
});

test("the trigger phrases are the D10-2 pair, and the keyword params carry them", () => {
  assert.deepEqual({ ...s.IOS_TRIGGER_KEYWORDS }, { primary: "مبلغ", english: "EGP" });
  const legacy = s.iosStepKeys({ phase: "enable", mode: "http", variant: "legacy", iosMajor: 26 });
  assert.equal(legacy.find((x) => x.key.endsWith("enable.legacy.s2"))?.params?.keyword, "مبلغ");
  assert.equal(legacy.find((x) => x.key.endsWith("enable.legacy.s6"))?.params?.keyword, "EGP");
});
