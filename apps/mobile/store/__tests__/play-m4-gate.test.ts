/**
 * Run:  cd apps/mobile && npx tsx --test store/__tests__/play-m4-gate.test.ts
 *
 * Doc 15 spec 14 §4.10 "Manifest gate (M4)", §4.13 and §5 step 14 (README §3 order 30): the Play
 * path of the Android notification listener, checked without a build.
 *
 *  PG-1  the resolved Expo config blocks every SMS-family permission and requests none of the gate's
 *        forbidden permissions (prebuild writes `blockedPermissions` as `tools:node="remove"`);
 *  PG-2  the config's blocked list and the merged-manifest guard (spec 11's
 *        `check-merged-manifest.mjs`) name the same SMS family, and the guard fails on each one;
 *  PG-3  no library the app can merge (the dependency closure of package.json, plus `modules/*`)
 *        declares a forbidden permission or an accessibility service in its main or release manifest;
 *  PG-4  every merged manifest on this machine (`android/` is gitignored; the release one comes from
 *        the EAS build, spec 11 step 16) passes the guard — or the one named by PLAY_GATE_MANIFEST,
 *        which must exist;
 *  PG-5  the prominent disclosure sits in front of the permission: on the Android path the consent
 *        step comes before the device (the token) and before the access step, the screen shows only
 *        the Android variant, and the module refuses the OS screen before `configure()`;
 *  PG-6  the Data safety answers cover every field the listener sends (Payload.kt): a new field
 *        fails here until spec 14 §4.10 / doc 11 §4 declare it.
 *
 * Release ⊆ debug: a release merged manifest only loses debug source sets; PG-3 also reads every
 * library's `src/release` manifest, so a forbidden entry cannot appear in release alone. The app's
 * build.gradle has no `releaseImplementation` dependency (checked 2026-10-19).
 * `tsx`, not plain Node: app.config.ts uses `__dirname`, wizard.ts has extensionless imports.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import config from "../../app.config";
// @ts-ignore — plain .mjs script without types
import { checkManifest } from "../../modules/collection-listener/scripts/check-merged-manifest.mjs";
import { consentOrder, resolveAutomationPath, stepsFor } from "../../src/components/collections/setup/wizard";

const here = dirname(fileURLToPath(import.meta.url));
const MOBILE = join(here, "../..");
const LISTENER = join(MOBILE, "modules/collection-listener");
const GUARD_SRC = readFileSync(join(LISTENER, "scripts/check-merged-manifest.mjs"), "utf8");
const MODULE_MANIFEST = join(LISTENER, "android/src/main/AndroidManifest.xml");

/** The SMS family the POS app must never hold (Play SMS / Call Log policy; 11 ARCH CR 5). */
const SMS_FAMILY = ["READ_SMS", "RECEIVE_SMS", "SEND_SMS", "RECEIVE_MMS", "RECEIVE_WAP_PUSH"];
/** 14 §4.10 = 11 §4.10 item 1: the whole forbidden list (accessibility is checked by name below). */
const GATE_FORBIDDEN = [
  ...SMS_FAMILY,
  "READ_CALL_LOG",
  "QUERY_ALL_PACKAGES",
  "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
  "FOREGROUND_SERVICE_SPECIAL_USE",
  "FOREGROUND_SERVICE_DATA_SYNC",
  "BIND_ACCESSIBILITY_SERVICE",
];
const leaf = (p: string) => p.split(".").pop()!;
const stripComments = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, "");
const permissionsIn = (xml: string): string[] =>
  [...stripComments(xml).matchAll(/<uses-permission(?:-sdk-23)?\b[^>]*android:name="([^"]+)"[^>]*>/g)].map((m) => m[1]);
const ACCESSIBILITY = /BIND_ACCESSIBILITY_SERVICE|android\.accessibilityservice\.AccessibilityService/;

test("PG-1: the resolved Expo config blocks the SMS family and requests no forbidden permission", () => {
  const android = config.android ?? {};
  const blocked = (android.blockedPermissions ?? []).map(leaf);
  for (const p of SMS_FAMILY) assert.ok(blocked.includes(p), `android.blockedPermissions lacks ${p}`);
  for (const p of android.blockedPermissions ?? []) assert.match(p, /^android\.permission\.[A-Z_]+$/, `unprefixed ${p}`);
  const requested = (android.permissions ?? []).map(leaf);
  for (const p of GATE_FORBIDDEN) assert.ok(!requested.includes(p), `android.permissions requests ${p}`);
  // A config plugin of our own must not add one either.
  for (const f of readdirSync(join(MOBILE, "plugins")).filter((f) => f.endsWith(".js"))) {
    const src = readFileSync(join(MOBILE, "plugins", f), "utf8");
    for (const p of GATE_FORBIDDEN) assert.ok(!src.includes(p), `plugins/${f} mentions ${p}`);
  }
});

/** A minimal merged manifest that passes the guard: the module's service and queries, nothing else. */
function mergedWith(extraPerm: string): string {
  const m = readFileSync(MODULE_MANIFEST, "utf8");
  const queries = /<queries>[\s\S]*?<\/queries>/.exec(m)![0];
  const service = /<service[\s\S]*?<\/service>/.exec(m)![0];
  return `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.thestoro.app">
    <uses-permission android:name="android.permission.INTERNET" />
    ${extraPerm}
    ${queries}
    <application>${service}</application>
</manifest>`;
}

test("PG-2: the blocked list and the merged-manifest guard name the same SMS family; the guard fails on each", () => {
  const block = /const FORBIDDEN = \[([\s\S]*?)\n\];/.exec(GUARD_SRC);
  assert.ok(block, "FORBIDDEN list not found in check-merged-manifest.mjs");
  const guardNames = [...block![1].matchAll(/\["([A-Z_]+)"/g)].map((m) => m[1]);
  for (const p of GATE_FORBIDDEN.filter((p) => p !== "BIND_ACCESSIBILITY_SERVICE")) {
    assert.ok(guardNames.includes(p), `the guard does not forbid ${p} (14 §4.10)`);
  }
  const guardSms = guardNames.filter((p) => /SMS|MMS|WAP_PUSH/.test(p)).sort();
  const blocked = (config.android?.blockedPermissions ?? []).map(leaf).filter((p) => /SMS|MMS|WAP_PUSH/.test(p)).sort();
  assert.deepEqual(blocked, guardSms, "app.config.ts blockedPermissions and the guard disagree on the SMS family");
  assert.deepEqual(checkManifest(mergedWith("")), [], "the base manifest must pass");
  for (const p of [...SMS_FAMILY, "READ_CALL_LOG", "QUERY_ALL_PACKAGES", "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"]) {
    const fails: string[] = checkManifest(mergedWith(`<uses-permission android:name="android.permission.${p}" />`));
    assert.equal(fails.length, 1, `${p}: ${fails.join(" | ")}`);
    assert.match(fails[0], /^FAIL /);
  }
  assert.ok(
    checkManifest(mergedWith('<uses-permission android:name="android.permission.BIND_ACCESSIBILITY_SERVICE" />')).some((f: string) =>
      /accessibility/.test(f),
    ),
    "the guard must fail on accessibility (the one item 14 §4.10 adds)",
  );
});

// ── PG-3: the libraries Gradle can merge ─────────────────────────────────────────────────────────

type Pkg = { name: string; dir: string };

/** Node-style lookup of `<name>/package.json` from `from` upwards (exports maps are ignored on purpose). */
function findPackage(name: string, from: string): string | null {
  let d = from;
  for (;;) {
    const p = join(d, "node_modules", name, "package.json");
    if (existsSync(p)) return dirname(p);
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** The runtime dependency closure of apps/mobile (dependencies + optional + peer), each package once. */
function dependencyClosure(): Pkg[] {
  const seen = new Map<string, Pkg>();
  const queue: Pkg[] = [{ name: "@matgary/mobile", dir: MOBILE }];
  while (queue.length) {
    const cur = queue.shift()!;
    let pj: Record<string, Record<string, string> | undefined>;
    try {
      pj = JSON.parse(readFileSync(join(cur.dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const names = new Set([
      ...Object.keys(pj.dependencies ?? {}),
      ...Object.keys(pj.optionalDependencies ?? {}),
      ...Object.keys(pj.peerDependencies ?? {}),
    ]);
    for (const n of names) {
      const dir = findPackage(n, cur.dir);
      if (!dir || seen.has(dir)) continue;
      const pkg = { name: n, dir };
      seen.set(dir, pkg);
      queue.push(pkg);
    }
  }
  return [...seen.values()];
}

const SKIP_DIRS = new Set(["build", "node_modules", "debug", "test", "androidTest", "example", "examples", "sample", "samples", ".gradle", ".cxx"]);

/** AndroidManifest*.xml under a package's Android project(s), excluding debug / test / sample source sets. */
function manifestsUnder(root: string, depth = 0, out: string[] = []): string[] {
  if (depth > 7 || !existsSync(root)) return out;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) manifestsUnder(join(root, e.name), depth + 1, out);
    } else if (/^AndroidManifest.*\.xml$/.test(e.name)) out.push(join(root, e.name));
  }
  return out;
}

test("PG-3: no mergeable library manifest (main or release) declares a forbidden permission or accessibility", (t) => {
  const pkgs = dependencyClosure();
  const files: string[] = [];
  for (const p of pkgs) for (const sub of ["android", "ReactAndroid"]) manifestsUnder(join(p.dir, sub), 0, files);
  for (const m of readdirSync(join(MOBILE, "modules"))) manifestsUnder(join(MOBILE, "modules", m, "android"), 0, files);
  // Non-vacuous: the scan must reach the libraries that do add permissions, and the listener.
  const rel = files.map((f) => relative(join(MOBILE, "../.."), f));
  for (const must of ["expo-notifications/android", "expo-location/android", "modules/collection-listener/android/src/main/AndroidManifest.xml"]) {
    assert.ok(rel.some((f) => f.includes(must)), `scan did not reach ${must} (${files.length} manifests)`);
  }
  assert.ok(files.length >= 30, `only ${files.length} library manifests found`);
  const offences: string[] = [];
  for (const f of files) {
    const xml = readFileSync(f, "utf8");
    for (const p of permissionsIn(xml)) if (GATE_FORBIDDEN.includes(leaf(p))) offences.push(`${relative(MOBILE, f)}: ${p}`);
    if (ACCESSIBILITY.test(stripComments(xml))) offences.push(`${relative(MOBILE, f)}: accessibility`);
  }
  t.diagnostic(`${pkgs.length} packages in the closure, ${files.length} library manifests read`);
  assert.deepEqual(offences, []);
  // The listener module itself declares no permission at all (11 §4.3).
  assert.deepEqual(permissionsIn(readFileSync(MODULE_MANIFEST, "utf8")), []);
});

// ── PG-4: merged manifests on this machine ───────────────────────────────────────────────────────

function mergedOnDisk(): string[] {
  const base = join(MOBILE, "android/app/build/intermediates/merged_manifest");
  if (!existsSync(base)) return [];
  const out: string[] = [];
  for (const variant of readdirSync(base)) {
    const vdir = join(base, variant);
    for (const task of readdirSync(vdir)) {
      const f = join(vdir, task, "AndroidManifest.xml");
      if (/^process\w+MainManifest$/.test(task) && existsSync(f)) out.push(f);
    }
  }
  return out;
}

const forced = process.env.PLAY_GATE_MANIFEST;
const onDisk = forced ? [forced] : mergedOnDisk();
const moduleMtime = statSync(MODULE_MANIFEST).mtimeMs;
const fresh = onDisk.filter((f) => forced || (existsSync(f) && statSync(f).mtimeMs >= moduleMtime));

test(
  "PG-4: every fresh merged manifest on this machine passes the guard (or PLAY_GATE_MANIFEST, which must exist)",
  {
    skip:
      fresh.length === 0
        ? onDisk.length === 0
          ? "no merged manifest here (android/ is gitignored): run the guard on the EAS build's release manifest (spec 11 step 16)"
          : `merged manifest older than the module manifest (${onDisk.map((f) => relative(MOBILE, f)).join(", ")}): regenerate it`
        : false,
  },
  (t) => {
    for (const f of fresh) {
      t.diagnostic(`guard OK on ${relative(MOBILE, f)}`);
      assert.ok(existsSync(f), `PLAY_GATE_MANIFEST ${f} does not exist`);
      const xml = readFileSync(f, "utf8");
      assert.deepEqual(checkManifest(xml), [], relative(MOBILE, f));
      const sms = permissionsIn(xml).filter((p) => /SMS|MMS|WAP_PUSH|CALL_LOG/.test(p));
      assert.deepEqual(sms, [], `${relative(MOBILE, f)} carries ${sms.join(", ")}`);
    }
  },
);

// ── PG-5: the prominent disclosure precedes the permission ───────────────────────────────────────

test("PG-5: on the Android path the disclosure (consent) comes before the token and the access step", () => {
  const path = resolveAutomationPath({
    os: "android",
    osVersion: 15,
    ingest: true,
    activeAccounts: 1,
    config: {},
    modules: { iosIntent: false, androidListener: true },
  });
  assert.equal(path.kind, "android_listener");
  const steps = stepsFor(path);
  const at = (s: string) => steps.indexOf(s as (typeof steps)[number]);
  assert.ok(at("consent") > 0, "no consent step");
  assert.ok(at("consent") < at("device"), "the device (and its token) must come after consent");
  assert.ok(at("device") < at("install"), "configure() + the access screen come after the device");
  // The screen is the Android variant only, title first, the decision last (14 §4.2 render contract).
  const order = consentOrder("android");
  assert.equal(order[0], "title");
  assert.deepEqual(order.slice(1, 5), ["android.lead", "android.reads", "android.sends", "android.key"]);
  assert.ok(!order.some((k) => k.startsWith("ios.")), "iOS text on the Android disclosure");
  assert.ok(order.indexOf("common.statement") < order.indexOf("agree"), "statement must sit above agree");
  // The native module refuses the OS screen before configure() (which needs the token).
  const kt = readFileSync(join(LISTENER, "android/src/main/java/expo/modules/collectionlistener/CollectionListenerModule.kt"), "utf8");
  const fn = /AsyncFunction\("openAccessSettings"\)\s*\{([\s\S]*?)\}\.runOnQueue/.exec(kt);
  assert.ok(fn, "openAccessSettings not found");
  assert.match(fn![1], /if \(!State\(ctx\)\.configured\) throw coded\("NOT_CONFIGURED"/);
  assert.ok(fn![1].indexOf("NOT_CONFIGURED") < fn![1].indexOf("Rebind.openAccessSettings"), "the refusal must come first");
});

// ── PG-6: Data safety covers what leaves the phone ───────────────────────────────────────────────

/** Every JSON key the listener writes → the Data safety row that declares it (14 §4.10, doc 11 §4). */
const DECLARED: Record<string, string> = {
  v: "envelope (schema version)",
  messages: "envelope",
  fp: "Messages → Other in-app messages (a SHA-256 fingerprint of the notification)",
  channel: "Messages → Other in-app messages (constant android_notification)",
  sourceApp: "Messages → Other in-app messages (the posting bank / wallet app)",
  title: "Messages → Other in-app messages",
  subtitle: "Messages → Other in-app messages",
  body: "Messages → Other in-app messages",
  receivedAt: "Messages → Other in-app messages",
  platform: "App info and performance → Diagnostics (constant android_listener)",
  appVersion: "App info and performance → Diagnostics",
  osVersion: "App info and performance → Diagnostics",
  listenerConnected: "App info and performance → Diagnostics",
  lastNotificationAt: "App info and performance → Diagnostics",
  lastUploadAt: "App info and performance → Diagnostics",
  queued: "App info and performance → Diagnostics",
  packagesInstalled: "App activity → Installed apps (SEC14-F7)",
  // A6 (11 ARCH CR 7): Android 15+ redaction counts, never text.
  redactedCount: "App info and performance → Diagnostics",
  lastRedactedAt: "App info and performance → Diagnostics",
  redactedByPackage: "App activity → Installed apps (SEC14-F7; allowlisted package ids → counts)",
};

test("PG-6: every field the listener sends has a Data safety row", () => {
  const kt = readFileSync(join(LISTENER, "android/src/main/java/expo/modules/collectionlistener/core/Payload.kt"), "utf8");
  // Code only (KDoc comments name the keys too): `\"key\":` inside Kotlin string literals.
  const code = kt.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const keys = [...new Set([...code.matchAll(/\\"(\w+)\\":/g)].map((m) => m[1]))].sort();
  assert.ok(keys.includes("body") && keys.includes("packagesInstalled"), `key scan found only ${keys.join(", ")}`);
  const undeclared = keys.filter((k) => !(k in DECLARED));
  assert.deepEqual(undeclared, [], "a new field leaves the phone: declare it in Play Data safety (14 §4.10, doc 11 §4), then here");
  const stale = Object.keys(DECLARED).filter((k) => !keys.includes(k));
  assert.deepEqual(stale, [], "a declared field is no longer sent: re-check the Data safety row");
});
