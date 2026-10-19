/**
 * Run:  cd apps/mobile && npx tsx --test modules/collections-ingest/__tests__/intent-plugin.test.ts
 *
 * Doc 15 spec 10 §4.11 / §5 step 17, the parts provable WITHOUT `expo prebuild` or Xcode (founder rule
 * 2026-10-18: no prebuild, no Xcode build on this Mac in this run):
 *   - strings: `mobile.collections.ios.intent.*` → `collections_intent_<snake>` merged into
 *     `locales[lang].ios["Localizable.strings"]` on top of ./locales/<lang>.json (files untouched);
 *     a value with `"`, `\` or a newline throws;
 *   - every `collections_intent_*` key the Swift intent names exists in both string tables, and back;
 *   - the plugin registers an iOS dangerous mod and an xcodeproj mod;
 *   - the Xcode mod on a COPY of the generated project adds the file to the app target's Sources
 *     exactly once across two runs (idempotent prebuilds); the copy step reproduces the source bytes;
 *   - app.config.ts lists the plugin after expo-splash-screen.
 * The real prebuild / `xcodebuild` / metadata-extraction proofs stay in spec 10 §5 step 17 (device phase).
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mobile = join(here, "../../..");
const require = createRequire(import.meta.url);
const plugin = require(join(mobile, "plugins/with-collections-intent.js"));
const SWIFT = readFileSync(join(mobile, "plugins/collections-intent/ForwardPaymentMessageIntent.swift"), "utf8");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

test("snakeCase maps the i18n names to the Swift keys", () => {
  assert.equal(plugin.snakeCase("title"), "title");
  assert.equal(plugin.snakeCase("paramReceivedAt"), "param_received_at");
  assert.equal(plugin.snakeCase("dialogTestFailed"), "dialog_test_failed");
  assert.equal(plugin.snakeCase("dialogNotLinked"), "dialog_not_linked");
});

test("buildIntentStrings: 14 keys per language, values verbatim from @matgary/i18n", () => {
  for (const lang of ["ar", "en"]) {
    const intent = plugin.loadIntentDict(lang);
    const strings = plugin.buildIntentStrings(intent, lang);
    assert.equal(Object.keys(strings).length, 14, lang);
    assert.equal(strings.collections_intent_title, intent.title);
    assert.equal(strings.collections_intent_param_received_at, intent.paramReceivedAt);
  }
  assert.equal(plugin.buildIntentStrings(plugin.loadIntentDict("en")).collections_intent_title, "Send payment message to TheStoro");
  assert.equal(plugin.buildIntentStrings(plugin.loadIntentDict("ar")).collections_intent_title, "إرسال رسالة دفع إلى ستورو");
});

test("buildIntentStrings refuses values Localizable.strings cannot hold", () => {
  for (const bad of ['say "hi"', "back\\slash", "two\nlines", "cr\r", "", "   "]) {
    assert.throws(() => plugin.buildIntentStrings({ title: bad }, "xx"), /with-collections-intent/, JSON.stringify(bad));
  }
  assert.throws(() => plugin.buildIntentStrings({ title: 5 }, "xx"));
});

test("every collections_intent_* key in the Swift intent exists in both tables, and back", () => {
  const inSwift = [...new Set([...SWIFT.matchAll(/LocalizedStringResource\(\s*"(collections_intent_[a-z_]+)"/g)].map((m) => m[1]))].sort();
  for (const lang of ["ar", "en"]) {
    const keys = Object.keys(plugin.buildIntentStrings(plugin.loadIntentDict(lang), lang)).sort();
    assert.deepEqual(inSwift, keys, lang);
  }
  assert.match(SWIFT, /struct ForwardPaymentMessageIntent: AppIntent/, "the frozen type name (spec 10 §8)");
  assert.match(SWIFT, /authenticationPolicy: IntentAuthenticationPolicy = \.alwaysAllowed/);
  assert.match(SWIFT, /^import CollectionsIngest$/m);
});

test("withIntentStrings merges on top of ./locales/<lang>.json and never edits them", () => {
  const before = ["ar", "en"].map((l) => sha(join(mobile, `locales/${l}.json`)));
  const cfg = plugin.withIntentStrings(
    { name: "TheStoro", slug: "thestoro", locales: { ar: "./locales/ar.json", en: "./locales/en.json" } },
    { projectRoot: mobile },
  );
  for (const lang of ["ar", "en"]) {
    const loc = cfg.locales[lang];
    const file = JSON.parse(readFileSync(join(mobile, `locales/${lang}.json`), "utf8"));
    assert.equal(loc.ios.CFBundleDisplayName, file.ios.CFBundleDisplayName, `${lang}: existing ios keys kept`);
    assert.deepEqual(loc.android, file.android, `${lang}: android kept`);
    assert.equal(Object.keys(loc.ios["Localizable.strings"]).length, 14);
  }
  // Applying twice is stable (an object locale is merged, not re-read).
  const twice = plugin.withIntentStrings(cfg, { projectRoot: mobile });
  assert.deepEqual(twice.locales, cfg.locales);
  assert.deepEqual(["ar", "en"].map((l) => sha(join(mobile, `locales/${l}.json`))), before, "locales/*.json changed");
});

test("the plugin registers an iOS dangerous mod and an xcodeproj mod", () => {
  const cfg = plugin({ name: "TheStoro", slug: "thestoro", locales: { ar: "./locales/ar.json", en: "./locales/en.json" },
    _internal: { projectRoot: mobile } });
  assert.equal(typeof cfg.mods?.ios?.dangerous, "function");
  assert.equal(typeof cfg.mods?.ios?.xcodeproj, "function");
  assert.ok(cfg.locales.ar.ios["Localizable.strings"].collections_intent_dialog_sent);
  assert.ok(!cfg.ios?.infoPlist?.UIBackgroundModes, "no background-mode change");
  assert.ok(!cfg.ios?.entitlements, "no entitlement change");
});

const PBX = join(mobile, "ios/stwrw.xcodeproj/project.pbxproj");
test("Xcode mod: added to the app target's Sources once across two runs (on a copy)", { skip: !existsSync(PBX) && "no generated ios/ project" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "intent-pbx-"));
  try {
    const copy = join(dir, "project.pbxproj");
    copyFileSync(PBX, copy);
    const xcode = require("xcode");
    let project = xcode.project(copy);
    project.parseSync();
    const already = project.hasFile("stwrw/CollectionsIntent/ForwardPaymentMessageIntent.swift");
    project = plugin.addIntentToProject(project, "stwrw");
    project = plugin.addIntentToProject(project, "stwrw");
    const text = project.writeSync();
    assert.equal(text.match(/ForwardPaymentMessageIntent\.swift in Sources \*\/ = \{isa = PBXBuildFile/g)?.length, 1);
    assert.equal(text.match(/\/\* ForwardPaymentMessageIntent\.swift in Sources \*\/,/g)?.length, 1, "one Sources phase entry");
    assert.match(text, /path = "?stwrw\/CollectionsIntent\/ForwardPaymentMessageIntent\.swift"?;/);
    // The Sources phase that holds it is the app target's (the one with AppDelegate.swift).
    const phases = [...text.matchAll(/\/\* Sources \*\/ = \{\s*isa = PBXSourcesBuildPhase;[\s\S]*?files = \(([\s\S]*?)\);/g)].map((m) => m[1]);
    const appPhase = phases.find((p) => p.includes("AppDelegate.swift in Sources"));
    assert.ok(appPhase?.includes("ForwardPaymentMessageIntent.swift in Sources"), "not in the app target's Sources");
    // Re-parse the written text and run again: still one (a second prebuild on the same project).
    const again = join(dir, "again.pbxproj");
    require("node:fs").writeFileSync(again, text);
    let p2 = xcode.project(again);
    p2.parseSync();
    p2 = plugin.addIntentToProject(p2, "stwrw");
    assert.equal(p2.writeSync().match(/ForwardPaymentMessageIntent\.swift in Sources \*\/ = \{isa = PBXBuildFile/g)?.length, 1);
    assert.equal(already, false, "the generated project already had the intent (unexpected before the M3 prebuild)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("copy step reproduces the source into <ios>/<project>/CollectionsIntent/", () => {
  const dir = mkdtempSync(join(tmpdir(), "intent-copy-"));
  try {
    const dest = plugin.copyIntentSource(dir, "stwrw");
    assert.equal(dest, join(dir, "stwrw/CollectionsIntent/ForwardPaymentMessageIntent.swift"));
    assert.equal(sha(dest), sha(join(mobile, "plugins/collections-intent/ForwardPaymentMessageIntent.swift")));
    plugin.copyIntentSource(dir, "stwrw"); // idempotent
    assert.equal(sha(dest), sha(join(mobile, "plugins/collections-intent/ForwardPaymentMessageIntent.swift")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("app.config.ts lists the plugin once, after expo-splash-screen", () => {
  const src = readFileSync(join(mobile, "app.config.ts"), "utf8");
  const at = src.indexOf('"./plugins/with-collections-intent.js"');
  assert.ok(at > src.indexOf('"expo-splash-screen"') && src.indexOf('"expo-splash-screen"') > -1);
  assert.equal(src.split('"./plugins/with-collections-intent.js"').length, 2);
});
