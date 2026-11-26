/**
 * Run:  cd apps/mobile && npx tsx --test modules/collection-listener/__tests__/manifest-parity.test.ts
 *
 * Doc 15 spec 11 §7.2 (manifest-parity row), 11 ARCH CHANGE REQUEST 3 (03 §B.10):
 *  - the `<package>` names in android/src/main/AndroidManifest.xml `<queries>` equal
 *    `packagesForProviders(<every CollectionProvider>)` from 06 (sorted) — a package added to
 *    `COLLECTION_PROVIDERS[*].androidPackages` is a native change and fails here until the manifest has it;
 *  - none of them is an SMS app (the Kotlin `SMS_APP_DENYLIST` is read from PackagePolicy.kt);
 *  - the service: `exported="false"`, `BIND_NOTIFICATION_LISTENER_SERVICE`, the NLS action,
 *    `disabled_filter_types` = `ongoing`; no `<uses-permission>` at all;
 *  - the OTP_PATTERNS / CANDIDATE_KEYWORDS fixtures in FilterTest.kt equal 06's constants.
 * `tsx`, not plain Node: 06's files have extensionless imports.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packagesForProviders } from "../../../../../packages/domain/src/collections/providers";
import { COLLECTION_PROVIDER_VALUES } from "../../../../../packages/domain/src/collections/types";
import { CANDIDATE_KEYWORDS, OTP_PATTERNS } from "../../../../../packages/domain/src/collections/filter";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = readFileSync(join(here, "../android/src/main/AndroidManifest.xml"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
const KT = join(here, "../android/src/main/java/expo/modules/collectionlistener");
const TEST_KT = join(here, "../android/src/test/java/expo/modules/collectionlistener/core/FilterTest.kt");

/** Kotlin string literals ("…" with \\ \" \$ escapes) between two markers. */
function ktStrings(src: string): string[] {
  return [...src.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, (_, c: string) => ({ n: "\n", t: "\t" })[c] ?? c));
}
function between(src: string, a: string, b: string): string {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i + a.length);
  assert.ok(i > -1 && j > i, `markers ${a} … ${b} not found`);
  return src.slice(i + a.length, j);
}

const queries = between(MANIFEST, "<queries>", "</queries>");
const queryPackages = [...queries.matchAll(/<package\s+android:name="([^"]+)"\s*\/>/g)].map((m) => m[1]);

test("<queries> == packagesForProviders(every CollectionProvider), sorted", () => {
  const want = packagesForProviders([...COLLECTION_PROVIDER_VALUES]);
  assert.equal(want.length, 11, "06's registry changed size: update the manifest <queries> AND this count (store build)");
  assert.deepEqual([...queryPackages].sort(), want);
  assert.equal(new Set(queryPackages).size, queryPackages.length, "duplicate <package>");
  assert.equal(/<intent>/.test(queries), false, "only <package> entries (no intent queries)");
});

test("no <queries> package is an SMS app; the Kotlin denylist has the four ids", () => {
  const policy = readFileSync(join(KT, "core/PackagePolicy.kt"), "utf8");
  const deny = ktStrings(between(policy, "SMS_APP_DENYLIST: Set<String> = setOf(", ")"));
  assert.deepEqual(deny.sort(), [
    "com.android.messaging",
    "com.android.mms",
    "com.google.android.apps.messaging",
    "com.samsung.android.messaging",
  ]);
  for (const p of queryPackages) {
    assert.equal(deny.includes(p), false, p);
    assert.equal(/messag|mms|sms/i.test(p), false, `${p} looks like an SMS app`);
  }
});

test("the service declaration: exported=false, BIND_NOTIFICATION_LISTENER_SERVICE, NLS action, ongoing filter", () => {
  const svc = between(MANIFEST, "<service", "</service>");
  assert.match(svc, /android:name="expo\.modules\.collectionlistener\.CollectionListenerService"/);
  assert.match(svc, /android:exported="false"/);
  assert.match(svc, /android:permission="android\.permission\.BIND_NOTIFICATION_LISTENER_SERVICE"/);
  assert.match(svc, /<action android:name="android\.service\.notification\.NotificationListenerService"\s*\/>/);
  assert.match(svc, /android:name="android\.service\.notification\.disabled_filter_types"\s+android:value="ongoing"/);
  assert.equal(/default_autobind_listenerservice/.test(svc), false, "absent = true: the system rebinds after boot");
  assert.equal(/android:label/.test(svc), false, "the settings list shows the app label");
  assert.equal((MANIFEST.match(/<service/g) ?? []).length, 1);
});

test("no <uses-permission>, no foreground service type, no QUERY_ALL_PACKAGES in the module manifest", () => {
  assert.equal(/<uses-permission/.test(MANIFEST), false);
  assert.equal(/foregroundServiceType/.test(MANIFEST), false);
  assert.equal(/QUERY_ALL_PACKAGES|SMS|REQUEST_IGNORE_BATTERY_OPTIMIZATIONS|ACCESSIBILITY/.test(MANIFEST), false);
});

test("FilterTest.kt fixtures == 06's OTP_PATTERNS and CANDIDATE_KEYWORDS", () => {
  const src = readFileSync(TEST_KT, "utf8");
  const otp = ktStrings(between(src, "// BEGIN OTP_PATTERNS fixture", "// END OTP_PATTERNS fixture"));
  assert.deepEqual(otp, [...OTP_PATTERNS]);
  const kw = between(src, "// BEGIN CANDIDATE_KEYWORDS fixture", "// END CANDIDATE_KEYWORDS fixture");
  assert.deepEqual(ktStrings(between(kw, "keywordsAr = listOf(", ")")), [...CANDIDATE_KEYWORDS.ar]);
  assert.deepEqual(ktStrings(between(kw, "keywordsEn = listOf(", ")")), [...CANDIDATE_KEYWORDS.en]);
});

test("core/, store/, net/, work/ stay free of Expo imports (the M5 Collector reuses them, 11 appendix)", () => {
  for (const dir of ["core", "store", "net", "work"]) {
    for (const f of readdirSync(join(KT, dir))) {
      const src = readFileSync(join(KT, dir, f), "utf8");
      assert.equal(/^import expo\.modules\.kotlin/m.test(src), false, `${dir}/${f} imports Expo`);
      assert.equal(/\bLog\.[dviwe]\(/.test(src) && !src.includes("isDebuggable"), false, `${dir}/${f} logs outside the debug guard`);
    }
  }
});
