/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/components/collections/setup/__tests__/wizard.test.ts
 *
 * `wizard.ts` has type-only imports. Cases: doc 15 spec 09 §7 (wizard.test.ts
 * row) — iosMajor, every resolveAutomationPath row of §4.6.1, stepsFor,
 * arrived (incl. the Postgres text form), deviceHealth's one local override —
 * plus the §4.6.6 resume table and 14 §4.2's consent order (14 §6.2 "09's own
 * test").
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import * as w from "../wizard.ts";

const LEGACY = "https://www.icloud.com/shortcuts/legacy";
const IOS27 = "https://www.icloud.com/shortcuts/ios27";
const I_LEGACY = "https://www.icloud.com/shortcuts/intent-legacy";
const I_27 = "https://www.icloud.com/shortcuts/intent-27";
const links = { iosShortcutUrl: IOS27, iosShortcutUrlLegacy: LEGACY, iosIntentShortcutUrl: null, iosIntentShortcutUrlLegacy: null };
const noModules = { iosIntent: false, androidListener: false };
const base = { os: "ios", osVersion: "26.3", ingest: true, activeAccounts: 2, config: links, modules: noModules };

test("COLLECTIONS_SETUP_TEST_MARKER and the D10-8 body (09 ARCH CR 8, 10 §4.8)", () => {
  assert.equal(w.COLLECTIONS_SETUP_TEST_MARKER, "THESTORO-SETUP-TEST");
  assert.equal(w.COLLECTIONS_SETUP_TEST_BODY, "THESTORO-SETUP-TEST تم استلام مبلغ 1.00 جنيه");
});

test("iosMajor", () => {
  assert.equal(w.iosMajor("26.5"), 26);
  assert.equal(w.iosMajor(27), 27);
  assert.equal(w.iosMajor("17.0.1"), 17);
  assert.equal(w.iosMajor(""), 0);
  assert.equal(w.iosMajor(undefined), 0);
});

test("resolveAutomationPath: rule 1 — ingest off wins over everything", () => {
  assert.deepEqual(w.resolveAutomationPath({ ...base, ingest: false, activeAccounts: 0, os: "android" }), { kind: "unsupported", reason: "ingest_off" });
});

test("resolveAutomationPath: rule 2 — no active account", () => {
  assert.deepEqual(w.resolveAutomationPath({ ...base, activeAccounts: 0 }), { kind: "unsupported", reason: "no_accounts" });
});

test("resolveAutomationPath: rule 3 — iOS 16.7 is too old", () => {
  assert.deepEqual(w.resolveAutomationPath({ ...base, osVersion: "16.7" }), { kind: "unsupported", reason: "ios_too_old" });
});

test("resolveAutomationPath: rules 4/8 — iOS 26 → legacy shortcut, iOS 27 → ios27 shortcut", () => {
  assert.deepEqual(w.resolveAutomationPath(base), {
    kind: "ios_shortcut", platform: "ios_shortcut", variant: "legacy", url: LEGACY, channels: ["ios_sms"], minutes: 4,
  });
  assert.deepEqual(w.resolveAutomationPath({ ...base, osVersion: "27.0" }), {
    kind: "ios_shortcut", platform: "ios_shortcut", variant: "ios27", url: IOS27, channels: ["ios_notification", "ios_sms"], minutes: 2,
  });
  assert.equal(w.resolveAutomationPath({ ...base, osVersion: "17.0.1" }).kind, "ios_shortcut");
});

test("resolveAutomationPath: rule 6 — iOS 27 with an empty iOS 27 URL → legacy with the legacy URL", () => {
  const p = w.resolveAutomationPath({ ...base, osVersion: 27, config: { ...links, iosShortcutUrl: "" } });
  assert.deepEqual(p, { kind: "ios_shortcut", platform: "ios_shortcut", variant: "legacy", url: LEGACY, channels: ["ios_sms"], minutes: 4 });
  const q = w.resolveAutomationPath({ ...base, osVersion: 27, config: { iosShortcutUrlLegacy: LEGACY } });
  assert.equal(q.kind === "ios_shortcut" && q.variant, "legacy");
});

test("resolveAutomationPath: rule 7 — no URL for the variant → link_missing (both env links unset)", () => {
  for (const osVersion of ["26.3", "27.0"]) {
    assert.deepEqual(w.resolveAutomationPath({ ...base, osVersion, config: {} }), { kind: "unsupported", reason: "link_missing" });
    assert.deepEqual(
      w.resolveAutomationPath({ ...base, osVersion, config: { iosShortcutUrl: null, iosShortcutUrlLegacy: "  " } }),
      { kind: "unsupported", reason: "link_missing" },
    );
  }
});

test("resolveAutomationPath: rule 5 (M3) — intent module + intent URLs", () => {
  const cfg = { ...links, iosIntentShortcutUrl: I_27, iosIntentShortcutUrlLegacy: I_LEGACY };
  const mods = { iosIntent: true, androidListener: false };
  assert.deepEqual(w.resolveAutomationPath({ ...base, osVersion: "27.1", config: cfg, modules: mods }), {
    kind: "ios_app_intent", platform: "ios_app_intent", variant: "ios27", url: I_27, channels: ["ios_notification", "ios_sms"], minutes: 2,
  });
  // iOS 27 with only a legacy intent URL → ios_app_intent / legacy.
  const only = { ...links, iosIntentShortcutUrlLegacy: I_LEGACY };
  assert.deepEqual(w.resolveAutomationPath({ ...base, osVersion: "27.1", config: only, modules: mods }), {
    kind: "ios_app_intent", platform: "ios_app_intent", variant: "legacy", url: I_LEGACY, channels: ["ios_sms"], minutes: 4,
  });
  assert.equal(w.resolveAutomationPath({ ...base, config: only, modules: mods }).kind, "ios_app_intent");
  // Module present but no intent link → the HTTP shortcut.
  assert.equal(w.resolveAutomationPath({ ...base, modules: mods }).kind, "ios_shortcut");
  // Intent links but no module (an M2 build) → never offered.
  assert.equal(w.resolveAutomationPath({ ...base, config: cfg }).kind, "ios_shortcut");
});

test("resolveAutomationPath: rules 9–11 — Android with / without the module; any other OS", () => {
  assert.deepEqual(w.resolveAutomationPath({ ...base, os: "android", osVersion: 35 }), { kind: "unsupported", reason: "android_pending" });
  assert.deepEqual(w.resolveAutomationPath({ ...base, os: "android", osVersion: 35, modules: { iosIntent: false, androidListener: true } }), {
    kind: "android_listener", platform: "android_listener", channels: ["android_notification"], minutes: 3,
  });
  assert.deepEqual(w.resolveAutomationPath({ ...base, os: "web" }), { kind: "unsupported", reason: "platform" });
});

test("stepsFor: the exact arrays of §4.6.2", () => {
  const seven = ["intro", "consent", "device", "install", "enable", "verify", "done"];
  assert.deepEqual([...w.stepsFor(w.resolveAutomationPath(base))], seven);
  assert.deepEqual([...w.stepsFor({ kind: "android_listener", platform: "android_listener", channels: ["android_notification"], minutes: 3 })], seven);
  assert.deepEqual([...w.stepsFor({ kind: "unsupported", reason: "ios_too_old" })], ["unsupported"]);
});

test("unsupportedKey maps each reason to a 09 §4.9 leaf", () => {
  assert.equal(w.unsupportedKey("ios_too_old"), "mobile.collections.setup.unsupported.iosTooOld");
  assert.equal(w.unsupportedKey("link_missing"), "mobile.collections.setup.unsupported.linkMissing");
  assert.equal(w.unsupportedKey("ingest_off"), "mobile.collections.setup.unsupported.ingestOff");
});

test("arrived: base null / now null / equal / newer / older; Postgres text form against ISO", () => {
  assert.equal(w.arrived(null, null), false);
  assert.equal(w.arrived(null, "2026-09-18T02:34:20.000Z"), true);
  assert.equal(w.arrived("2026-09-18T02:34:20.000Z", null), false);
  assert.equal(w.arrived("2026-09-18T02:34:20.000Z", "2026-09-18T02:34:20.000Z"), false);
  assert.equal(w.arrived("2026-09-18T02:34:20.000Z", "2026-09-18T02:34:21.000Z"), true);
  assert.equal(w.arrived("2026-09-18T02:34:21.000Z", "2026-09-18T02:34:20.000Z"), false);
  assert.equal(w.arrived("2026-09-18T02:34:20.000Z", "2026-09-18 02:34:20.571236+00"), true);
  assert.equal(w.arrived("2026-09-18 02:34:20.571236+00", "2026-09-18T02:34:20.500Z"), false);
  assert.equal(w.normalizeTs("2026-09-18 02:34:20.571236+00"), "2026-09-18T02:34:20.571+00:00");
});

test("deviceHealth: the server value unchanged; this Android phone with access off → listener_off, never over revoked", () => {
  const now = Date.parse("2026-10-19T00:00:00Z");
  for (const h of ["ok", "never_seen", "silent", "listener_off", "heartbeat_late", "revoked"]) {
    assert.equal(w.deviceHealth({ id: "d1", platform: "ios_shortcut", health: h }, now), h);
  }
  const local = { thisDeviceId: "a1", os: "android", accessGranted: false };
  for (const h of ["ok", "silent", "heartbeat_late", "never_seen"]) {
    assert.equal(w.deviceHealth({ id: "a1", platform: "android_listener", health: h }, now, local), "listener_off", h);
  }
  assert.equal(w.deviceHealth({ id: "a1", platform: "android_listener", health: "revoked" }, now, local), "revoked");
  // Another device, or iOS, ignores the local flag.
  assert.equal(w.deviceHealth({ id: "a2", platform: "android_listener", health: "ok" }, now, local), "ok");
  assert.equal(w.deviceHealth({ id: "a1", platform: "ios_shortcut", health: "ok" }, now, { ...local, os: "ios" }), "ok");
  assert.equal(w.deviceHealth({ id: "a1", platform: "android_listener", health: "ok" }, now, { ...local, accessGranted: true }), "ok");
});

test("healthTone: the seven rows' badges; unknown → no badge", () => {
  assert.equal(w.healthTone("listener_off"), "danger");
  assert.equal(w.healthTone("silent"), "danger");
  assert.equal(w.healthTone("heartbeat_late"), "warning");
  assert.equal(w.healthTone("never_seen"), "neutral");
  assert.equal(w.healthTone("ok"), "success");
  assert.equal(w.healthTone("revoked"), null);
  assert.equal(w.healthTone("future_value"), null);
});

test("knownWarnings (A6): known values only, deduped; none when revoked or from an older server", () => {
  assert.deepEqual(w.knownWarnings({ warnings: ["notifications_hidden"], revokedAt: null }), ["notifications_hidden"]);
  assert.deepEqual(w.knownWarnings({ warnings: ["notifications_hidden", "future_value", "notifications_hidden", 3] }), ["notifications_hidden"]);
  assert.deepEqual(w.knownWarnings({ warnings: ["notifications_hidden"], revokedAt: "2026-10-19T08:00:00.000Z" }), []);
  assert.deepEqual(w.knownWarnings({}), []);
  assert.deepEqual(w.knownWarnings({ warnings: null }), []);
  // Every known warning has copy (text + hint) in both dictionaries.
  const src = join(dirname(fileURLToPath(import.meta.url)), "../../../../../../../packages/i18n/src");
  for (const l of ["ar", "en"]) {
    const d = JSON.parse(readFileSync(join(src, `${l}.json`), "utf8")).mobile.collections.setup.devices.warnings as Record<string, unknown>;
    for (const k of w.KNOWN_DEVICE_WARNINGS) {
      assert.equal(typeof d[k], "string", `${l} ${k}`);
      assert.equal(typeof d[`${k}Hint`], "string", `${l} ${k}Hint`);
    }
  }
});

test("resumeAction: the §4.6.6 table", () => {
  const rec = (over: Partial<typeof w.EMPTY_RECORD>) => ({ ...w.EMPTY_RECORD, ...over });
  const live = { ok: true as const, liveIds: ["d1"] };
  assert.deepEqual(w.resumeAction(null, live), { kind: "start" });
  assert.deepEqual(w.resumeAction(rec({}), live), { kind: "start" });
  // Absent only on a successful list; offline / 5xx / 403 keep everything.
  assert.deepEqual(w.resumeAction(rec({ deviceId: "d2", tokenDelivered: true }), live), { kind: "clear" });
  assert.deepEqual(w.resumeAction(rec({ deviceId: "d2", tokenDelivered: true }), { ok: false }), { kind: "keep" });
  assert.deepEqual(w.resumeAction(rec({ deviceId: "d1", tokenDelivered: false }), live), { kind: "token_lost", replacesDeviceId: "d1" });
  assert.deepEqual(w.resumeAction(rec({ deviceId: "d1", tokenDelivered: true }), live), { kind: "resume_enable" });
  assert.deepEqual(w.resumeAction(rec({ deviceId: "d1", tokenDelivered: true, completedAt: "2026-10-19T00:00:00Z" }), live), { kind: "summary" });
  // A pending replacement (the lost token was already seen) restarts at consent even offline.
  assert.deepEqual(w.resumeAction(rec({ replacesDeviceId: "d1" }), { ok: false }), { kind: "token_lost", replacesDeviceId: "d1" });
});

test("entryHint: hintOff / hintPending / hintOn", () => {
  assert.equal(w.entryHint(null), "hintOff");
  assert.equal(w.entryHint({ ...w.EMPTY_RECORD, deviceId: "d1" }), "hintPending");
  assert.equal(w.entryHint({ ...w.EMPTY_RECORD, deviceId: "d1", completedAt: "x" }), "hintOn");
});

test("shortcut URLs use the exact installed name and the marker", () => {
  const name = "ستورو — تأكيد التحويلات";
  assert.equal(w.shortcutOpenUrl(name), "shortcuts://open-shortcut?name=" + encodeURIComponent(name));
  const run = w.shortcutRunTestUrl(name);
  assert.ok(run.startsWith("shortcuts://run-shortcut?name=" + encodeURIComponent(name) + "&input=text&text="));
  assert.ok(run.endsWith("THESTORO-SETUP-TEST"));
});

test("tokenPrefix shows mgi_ + 8 chars; simulateTestBody is 07's ingest shape with test: true", () => {
  assert.equal(w.tokenPrefix("mgi_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"), "mgi_abcdefgh");
  const b = w.simulateTestBody("ios_sms", "a".repeat(32), new Date("2026-10-19T00:00:00Z"));
  assert.deepEqual(b, {
    v: 1,
    messages: [{ fp: "a".repeat(32), channel: "ios_sms", sender: "TheStoro", body: w.COLLECTIONS_SETUP_TEST_BODY, receivedAt: "2026-10-19T00:00:00.000Z", test: true }],
  });
});

test("consentOrder: 14 §4.2's binding order, every key resolves in ar and en (14 §6.2)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = join(here, "../../../../../../../packages/i18n/src");
  const dict = (l: string) => JSON.parse(readFileSync(join(src, `${l}.json`), "utf8"));
  const at = (d: unknown, p: string) => p.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), d);
  for (const variant of ["ios", "android"] as const) {
    const order = w.consentOrder(variant);
    assert.deepEqual(order.slice(0, 5), ["title", `${variant}.lead`, `${variant}.reads`, `${variant}.sends`, `${variant}.key`]);
    assert.ok(order.indexOf("privacyLink") < order.indexOf("common.statement"));
    assert.ok(order.indexOf("common.statement") < order.indexOf("agree"));
    for (const l of ["ar", "en"]) {
      const consent = at(dict(l), "mobile.collections.consent");
      for (const k of order) assert.equal(typeof at(consent, k), "string", `${l}: ${k}`);
    }
    // Every leaf of the variant + common is rendered (nothing skipped).
    const consent = at(dict("en"), "mobile.collections.consent") as Record<string, Record<string, string>>;
    const expected = [
      ...Object.keys(consent[variant]).map((k) => `${variant}.${k}`),
      ...Object.keys(consent.common).map((k) => `common.${k}`),
    ];
    for (const k of expected) assert.ok(order.includes(k), k);
  }
});

test("clampLabel: ≤ 60 chars, trimmed", () => {
  assert.equal(w.clampLabel("  Ahmed — iPhone 15  "), "Ahmed — iPhone 15");
  assert.equal(w.clampLabel("x".repeat(70)).length, 60);
});

test("forwardsLineVisible: deviceId + completedAt on the M2 shortcut path; the native answer wins at M3/M4", () => {
  const rec = { ...w.EMPTY_RECORD, deviceId: "d1" };
  assert.equal(w.forwardsLineVisible(null), false);
  assert.equal(w.forwardsLineVisible({ ...w.EMPTY_RECORD }), false);
  assert.equal(w.forwardsLineVisible(rec), false);
  assert.equal(w.forwardsLineVisible({ ...rec, completedAt: "2026-10-19T00:00:00Z" }), true);
  assert.equal(w.forwardsLineVisible(rec, true), true);
  assert.equal(w.forwardsLineVisible({ ...rec, completedAt: "x" }, false), false);
});
