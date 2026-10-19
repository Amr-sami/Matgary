#!/usr/bin/env node
// Play-path guard over the APP's merged AndroidManifest.xml (doc 15 spec 11 §4.10 items 1–2, §5 step 13;
// 14 §4.10). Usage:
//
//   node modules/collection-listener/scripts/check-merged-manifest.mjs \
//     android/app/build/intermediates/merged_manifest/debug/processDebugMainManifest/AndroidManifest.xml
//
// Prints `OK` and exits 0, or prints one `FAIL <reason>` line per problem and exits 1. It fails when:
//  - an SMS / call-log / package-visibility / battery-exemption / FGS-type permission is merged in
//    (READ_SMS, RECEIVE_SMS, SEND_SMS, RECEIVE_MMS, RECEIVE_WAP_PUSH, READ_CALL_LOG, QUERY_ALL_PACKAGES,
//    REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, FOREGROUND_SERVICE_SPECIAL_USE, FOREGROUND_SERVICE_DATA_SYNC);
//  - anything accessibility is present (BIND_ACCESSIBILITY_SERVICE or an AccessibilityService);
//  - the listener service is missing, not exported="false", or not protected by
//    BIND_NOTIFICATION_LISTENER_SERVICE;
//  - `<queries>` lacks one of the 11 bank / wallet packages of 11 §4.3;
//  - a foreground service appears that is not the pre-existing baseline (§4.10 item 2: the
//    FOREGROUND_SERVICE permission, WorkManager's SystemForegroundService without a type, and
//    expo-location's LocationTaskService with foregroundServiceType="location"). The module itself
//    declares and starts none (D11-d).
// Pure Node, no dependencies; the XML is scanned with regular expressions (a merged manifest is
// machine-written, one element per tag).
import { readFileSync } from "node:fs";

/** 11 §4.3 = packagesForProviders(every CollectionProvider); manifest-parity.test.ts pins the module copy. */
export const REQUIRED_QUERIES = [
  "com.BanqueMisr.MobileBanking",
  "com.TE.WEWallet",
  "com.cibeg.ddc1.digitalbanking.live",
  "com.egyptianbanks.instapay",
  "com.emeint.android.mwallet",
  "com.emeint.android.mwallet.bm",
  "com.emeint.android.myservices",
  "com.etisalat.flous",
  "com.ofss.obdx.and.nbe.com.eg",
  "com.orange.mobinilandme",
  "eg.com.qnb.eazymobile",
];

const FORBIDDEN = [
  ["READ_SMS", "READ/RECEIVE SMS permission present"],
  ["RECEIVE_SMS", "READ/RECEIVE SMS permission present"],
  ["SEND_SMS", "SEND_SMS permission present"],
  ["RECEIVE_MMS", "RECEIVE_MMS permission present"],
  ["RECEIVE_WAP_PUSH", "RECEIVE_WAP_PUSH permission present"],
  ["READ_CALL_LOG", "READ_CALL_LOG permission present"],
  ["QUERY_ALL_PACKAGES", "QUERY_ALL_PACKAGES permission present"],
  ["REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS permission present"],
  ["FOREGROUND_SERVICE_SPECIAL_USE", "FOREGROUND_SERVICE_SPECIAL_USE permission present"],
  ["FOREGROUND_SERVICE_DATA_SYNC", "FOREGROUND_SERVICE_DATA_SYNC permission present"],
];

const SERVICE = "expo.modules.collectionlistener.CollectionListenerService";

/** The FGS baseline that predates the module (§4.10 item 2). Anything else with a type is new. */
const FGS_BASELINE = new Map([
  ["androidx.work.impl.foreground.SystemForegroundService", null],
  ["expo.modules.location.services.LocationTaskService", "location"],
]);

const attr = (tag, name) => {
  const m = new RegExp(`android:${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
};

/** Each `<tag …>` (self-closing or opening) of the given element name. */
function tags(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map((m) => m[0]);
}

export function checkManifest(xmlRaw) {
  const xml = xmlRaw.replace(/<!--[\s\S]*?-->/g, "");
  const fails = [];
  const add = (r) => {
    if (!fails.includes(r)) fails.push(r);
  };

  // 1. Permissions (uses-permission and uses-permission-sdk-23 alike).
  const perms = [...tags(xml, "uses-permission"), ...tags(xml, "uses-permission-sdk-23")]
    .map((t) => attr(t, "name") ?? "")
    .filter(Boolean);
  for (const p of perms) {
    const leaf = p.split(".").pop();
    for (const [bad, reason] of FORBIDDEN) if (leaf === bad) add(`FAIL ${reason}`);
  }

  // 2. Accessibility, anywhere.
  if (/BIND_ACCESSIBILITY_SERVICE|android\.accessibilityservice\.AccessibilityService/.test(xml)) {
    add("FAIL accessibility service present");
  }

  // 3. Services: the listener, and the FGS baseline.
  const services = tags(xml, "service");
  const listener = services.filter((t) => attr(t, "name") === SERVICE);
  if (listener.length !== 1) {
    add("FAIL CollectionListenerService missing");
  } else {
    const t = listener[0];
    if (attr(t, "exported") !== "false") add("FAIL CollectionListenerService is not exported=\"false\"");
    if (attr(t, "permission") !== "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE") {
      add("FAIL CollectionListenerService is not protected by BIND_NOTIFICATION_LISTENER_SERVICE");
    }
    if (attr(t, "foregroundServiceType") != null) add("FAIL CollectionListenerService declares a foreground service type");
  }
  for (const t of services) {
    const type = attr(t, "foregroundServiceType");
    const name = attr(t, "name") ?? "?";
    if (type == null) continue;
    if (!FGS_BASELINE.has(name) || FGS_BASELINE.get(name) !== type) {
      add(`FAIL new foreground service ${name} (${type})`);
    }
  }
  for (const p of perms) {
    if (/^android\.permission\.FOREGROUND_SERVICE_/.test(p) && !FORBIDDEN.some(([b]) => p.endsWith(b))) {
      // A typed FGS permission the baseline does not have (e.g. FOREGROUND_SERVICE_LOCATION is allowed
      // only together with expo-location's service).
      if (!(p === "android.permission.FOREGROUND_SERVICE_LOCATION" && services.some((t) => attr(t, "name") === "expo.modules.location.services.LocationTaskService"))) {
        add(`FAIL new foreground service permission ${p}`);
      }
    }
  }

  // 4. <queries> must list every bank / wallet package.
  const queryBlocks = [...xml.matchAll(/<queries>([\s\S]*?)<\/queries>/g)].map((m) => m[1]).join("\n");
  const have = new Set(tags(queryBlocks, "package").map((t) => attr(t, "name")));
  const missing = REQUIRED_QUERIES.filter((p) => !have.has(p));
  if (missing.length) add(`FAIL <queries> lacks ${missing.join(", ")}`);

  return fails;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-merged-manifest.mjs");
if (isMain) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: check-merged-manifest.mjs <merged AndroidManifest.xml>");
    process.exit(2);
  }
  let xml;
  try {
    xml = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`FAIL cannot read ${path}: ${e.code ?? e.message}`);
    process.exit(2);
  }
  const fails = checkManifest(xml);
  if (fails.length === 0) {
    console.log("OK");
    process.exit(0);
  }
  for (const f of fails) console.log(f);
  process.exit(1);
}
