/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/components/collections/setup/__tests__/android-steps.test.ts
 *
 * Doc 15 spec 09 step 19 (the Android branch's pure rules) + spec 11 §4.9: OEM section picking, the
 * checklist and troubleshooting keys, the required-app list from 06's registry (read from
 * providers.ts as text — Node cannot load its extensionless imports), the Android verify rule of
 * 09 §4.6.7, the dev-only ingest-URL rebase, and that every key the branch renders exists in BOTH
 * dictionaries with the same `{placeholders}`.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import * as a from "../android-steps.ts";
// prettier-ignore
// @ts-ignore TS5097
import { arrived } from "../wizard.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../../../../..");
const PROVIDERS_TS = readFileSync(join(root, "packages/domain/src/collections/providers.ts"), "utf8");

type Reg = Record<string, { rail: "instapay" | "wallet"; androidPackages: string[] }>;
function registryFromSource(): Reg {
  const out: Reg = {};
  for (const m of PROVIDERS_TS.matchAll(/entry\(\s*"(\w+)",\s*"(instapay|wallet)",\s*\[([^\]]*)\]/g)) {
    out[m[1]] = { rail: m[2] as "instapay" | "wallet", androidPackages: [...m[3].matchAll(/"([^"]+)"/g)].map((x) => x[1]) };
  }
  return out;
}
const REG = registryFromSource();

test("the registry parse found all 18 providers, and INSTAPAY_APP_PACKAGE matches 06", () => {
  assert.equal(Object.keys(REG).length, 18);
  assert.match(PROVIDERS_TS, new RegExp(`INSTAPAY_APP_PACKAGE = "${a.INSTAPAY_APP_PACKAGE.replace(/\./g, "\\.")}"`));
});

test("oemSection: xiaomi / samsung / oppo / realme by manufacturer, else generic (Transsion has none yet)", () => {
  assert.equal(a.oemSection("Xiaomi"), "xiaomi");
  assert.equal(a.oemSection("Redmi"), "xiaomi");
  assert.equal(a.oemSection("POCO"), "xiaomi");
  assert.equal(a.oemSection("samsung"), "samsung");
  assert.equal(a.oemSection("OPPO"), "oppo");
  assert.equal(a.oemSection("realme"), "realme");
  assert.equal(a.oemSection("Google"), "generic");
  assert.equal(a.oemSection("INFINIX MOBILITY LIMITED"), "generic");
  assert.equal(a.oemSection(null), "generic");
  assert.equal(a.oemSection(""), "generic");
});

test("oemStepKeys: 3 / 2 / 3 / 2 / 2 steps, in order", () => {
  assert.deepEqual(a.oemStepKeys("xiaomi"), [1, 2, 3].map((n) => `mobile.collections.android.oem.xiaomi.step${n}`));
  assert.equal(a.oemStepKeys("samsung").length, 2);
  assert.equal(a.oemStepKeys("oppo").length, 3);
  assert.equal(a.oemStepKeys("realme").length, 2);
  assert.deepEqual(a.oemStepKeys("generic"), ["mobile.collections.android.oem.generic.step1", "mobile.collections.android.oem.generic.step2"]);
});

test("requiredApps: InstaPay app first for any instapay-rail account, then each provider's packages, deduped", () => {
  assert.deepEqual(a.requiredApps(["cib", "vodafone_cash", "cib"], REG), [
    { pkg: "com.egyptianbanks.instapay", labelKey: "mobile.collections.android.instapayApp" },
    { pkg: "com.cibeg.ddc1.digitalbanking.live", labelKey: "app.collections.vocab.providers.cib" },
    { pkg: "com.emeint.android.myservices", labelKey: "app.collections.vocab.providers.vodafone_cash" },
  ]);
  // A wallet-only shop needs no InstaPay app.
  assert.deepEqual(a.requiredApps(["orange_cash"], REG).map((r: { pkg: string }) => r.pkg), ["com.orange.mobinilandme"]);
  // A bank without a known app (bdc) still brings the InstaPay app.
  assert.deepEqual(a.requiredApps(["bdc"], REG).map((r: { pkg: string }) => r.pkg), ["com.egyptianbanks.instapay"]);
  assert.deepEqual(a.requiredApps(["other_wallet", "unknown_id"], REG), []);
});

test("appRows / noneInstalled", () => {
  const req = a.requiredApps(["cib", "etisalat_money"], REG);
  const rows = a.appRows(req, ["com.etisalat.flous"]);
  assert.deepEqual(
    rows.map((r: { pkg: string; installed: boolean; key: string }) => [r.pkg, r.installed, r.key.split(".").pop()]),
    [
      ["com.egyptianbanks.instapay", false, "appMissing"],
      ["com.cibeg.ddc1.digitalbanking.live", false, "appMissing"],
      ["com.etisalat.flous", true, "appInstalled"],
    ],
  );
  assert.equal(a.noneInstalled(rows), false);
  assert.equal(a.noneInstalled(a.appRows(req, [])), true);
  assert.equal(a.noneInstalled([]), false, "no required app → nothing to warn about");
});

test("androidVerifyPassed: connected AND (lastSeenAt OR lastMessageAt newer than the baseline)", () => {
  const base = { baselineSeenAt: "2026-10-19T08:00:00.000Z", baselineMessageAt: null };
  const seenLater = { lastSeenAt: "2026-10-19 08:00:05.123456+00", lastMessageAt: null };
  assert.equal(a.androidVerifyPassed({ connected: true, ...base, ...seenLater }, arrived), true);
  assert.equal(a.androidVerifyPassed({ connected: false, ...base, ...seenLater }, arrived), false, "never before connected");
  assert.equal(a.androidVerifyPassed({ connected: true, ...base, lastSeenAt: base.baselineSeenAt, lastMessageAt: null }, arrived), false);
  assert.equal(
    a.androidVerifyPassed({ connected: true, ...base, lastSeenAt: base.baselineSeenAt, lastMessageAt: "2026-10-19T08:01:00Z" }, arrived),
    true,
  );
  // A device created moments ago with no heartbeat yet: base null, first heartbeat → pass.
  assert.equal(
    a.androidVerifyPassed({ connected: true, baselineSeenAt: null, baselineMessageAt: null, lastSeenAt: "2026-10-19T08:00:01Z", lastMessageAt: null }, arrived),
    true,
  );
});

test("listenerIngestUrl: the server URL wins in release; dev re-bases onto the app's API origin", () => {
  const server = "http://localhost:3003/api/v1/collections/ingest";
  assert.equal(a.listenerIngestUrl(server, "http://10.0.2.2:3003", false), server);
  assert.equal(a.listenerIngestUrl(server, "http://10.0.2.2:3003", true), "http://10.0.2.2:3003/api/v1/collections/ingest");
  assert.equal(a.listenerIngestUrl("https://thestoro.com/api/v1/collections/ingest", "https://thestoro.com/", true), "https://thestoro.com/api/v1/collections/ingest");
  assert.equal(a.listenerIngestUrl(null, "https://thestoro.com/", false), "https://thestoro.com/api/v1/collections/ingest");
  assert.equal(a.configPathOf("https://thestoro.com/api/v1/collections/ingest/"), "/api/v1/collections/ingest/config");
});

type Dict = Record<string, unknown>;
const load = (l: string): Dict => JSON.parse(readFileSync(join(root, `packages/i18n/src/${l}.json`), "utf8")) as Dict;
const at = (d: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Dict)[k] : undefined), d);
const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("refreshNowAndOnActive: runs now, again on each return to active, never after cleanup (09 step 20)", () => {
  let listener: ((s: string) => void) | null = null;
  let removed = 0;
  const appState = {
    addEventListener(_type: "change", cb: (s: string) => void) {
      listener = cb;
      return { remove: () => { removed++; listener = null; } };
    },
  };
  let runs = 0;
  const cleanup = a.refreshNowAndOnActive(appState, () => { runs++; });
  assert.equal(runs, 1);
  listener!("background");
  listener!("inactive");
  assert.equal(runs, 1);
  listener!("active");
  assert.equal(runs, 2);
  cleanup();
  assert.equal(removed, 1);
  assert.equal(listener, null);
});

test("every key the Android branch renders exists in ar AND en with the same placeholders", () => {
  const ar = load("ar");
  const en = load("en");
  const keys = [
    ...a.allAndroidKeys(),
    // 09's frame keys the branch uses
    "mobile.collections.setup.install.openAccess",
    "mobile.collections.setup.install.openBattery",
    "mobile.collections.setup.install.connected",
    "mobile.collections.setup.install.notConnected",
    "mobile.collections.setup.install.configureFailed",
    "mobile.collections.setup.verify.bodyAndroid",
    "mobile.collections.setup.intro.pathAndroid",
  ];
  for (const k of keys) {
    const va = at(ar, k);
    const ve = at(en, k);
    assert.equal(typeof va, "string", `ar missing ${k}`);
    assert.equal(typeof ve, "string", `en missing ${k}`);
    assert.deepEqual(ph(va as string), ph(ve as string), `placeholders differ for ${k}`);
  }
  assert.deepEqual(ph(at(en, "mobile.collections.android.install.appMissing") as string), ["app"]);
  // The provider names that fill {app} exist (05's subtree).
  for (const id of Object.keys(REG)) assert.equal(typeof at(en, `app.collections.vocab.providers.${id}`), "string", id);
});

test("the ar/en leaf sets under mobile.collections.android are equal (11 §6 criterion 13)", () => {
  const leaves = (d: unknown, p = ""): string[] =>
    d && typeof d === "object"
      ? Object.entries(d as Dict).flatMap(([k, v]) => (typeof v === "string" ? [p + k] : leaves(v, p + k + ".")))
      : [];
  const ar = leaves(at(load("ar"), "mobile.collections.android")).sort();
  const en = leaves(at(load("en"), "mobile.collections.android")).sort();
  assert.equal(ar.length, 35);
  assert.deepEqual(ar, en);
});
