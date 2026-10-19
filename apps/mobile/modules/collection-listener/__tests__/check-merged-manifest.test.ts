/**
 * Run:  cd apps/mobile && npx tsx --test modules/collection-listener/__tests__/check-merged-manifest.test.ts
 *
 * Doc 15 spec 11 §5 step 13 / §4.10: the Play-path guard. A merged manifest made of the 2026-09-19
 * baseline entries (FOREGROUND_SERVICE, WorkManager's SystemForegroundService, expo-location's
 * LocationTaskService) plus this module's manifest prints OK; adding RECEIVE_SMS prints
 * `FAIL READ/RECEIVE SMS permission present` and exits 1; every other §4.10 rule has a negative case.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore — plain .mjs script without types
import { checkManifest, REQUIRED_QUERIES } from "../scripts/check-merged-manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "../scripts/check-merged-manifest.mjs");
const MODULE = readFileSync(join(here, "../android/src/main/AndroidManifest.xml"), "utf8");

const moduleQueries = /<queries>[\s\S]*?<\/queries>/.exec(MODULE)![0];
const moduleService = /<service[\s\S]*?<\/service>/.exec(MODULE)![0];

/** The baseline entries §4.10 item 2 names, in merged-manifest form, plus the module's merged parts. */
function merged(extraPerms = "", extraApp = "", service = moduleService, queries = moduleQueries): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.thestoro.app">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission-sdk-23 android:name="android.permission.ACCESS_FINE_LOCATION" />
    ${extraPerms}
    <queries>
        <intent><action android:name="android.intent.action.VIEW" /></intent>
        <package android:name="host.exp.exponent" />
    </queries>
    ${queries}
    <application android:allowBackup="false">
        <service android:name="expo.modules.location.services.LocationTaskService" android:exported="false" android:foregroundServiceType="location" />
        <service android:name="androidx.work.impl.foreground.SystemForegroundService" android:directBootAware="false" android:enabled="@bool/enable_system_foreground_service_default" android:exported="false" />
        <service android:name="androidx.work.impl.background.systemjob.SystemJobService" android:exported="true" android:permission="android.permission.BIND_JOB_SERVICE" />
        ${service}
        ${extraApp}
    </application>
</manifest>`;
}

function run(xml: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "cmm-"));
  const p = join(dir, "AndroidManifest.xml");
  writeFileSync(p, xml);
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, p], { encoding: "utf8" }) };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
}

test("baseline + the module's manifest → OK, exit 0", () => {
  assert.deepEqual(checkManifest(merged()), []);
  assert.deepEqual(run(merged()), { code: 0, out: "OK\n" });
  assert.equal(REQUIRED_QUERIES.length, 11);
});

test("RECEIVE_SMS added → FAIL READ/RECEIVE SMS permission present, exit 1 (the §5 step 13 negative)", () => {
  const r = run(merged('<uses-permission android:name="android.permission.RECEIVE_SMS"/>'));
  assert.equal(r.code, 1);
  assert.equal(r.out, "FAIL READ/RECEIVE SMS permission present\n");
});

test("every forbidden permission fails", () => {
  for (const p of ["READ_SMS", "SEND_SMS", "RECEIVE_MMS", "RECEIVE_WAP_PUSH", "READ_CALL_LOG", "QUERY_ALL_PACKAGES",
    "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", "FOREGROUND_SERVICE_SPECIAL_USE", "FOREGROUND_SERVICE_DATA_SYNC"]) {
    const f = checkManifest(merged(`<uses-permission android:name="android.permission.${p}" />`));
    assert.equal(f.length, 1, `${p}: ${f.join(" | ")}`);
    assert.match(f[0], /^FAIL /);
  }
  // uses-permission-sdk-23 counts too.
  assert.equal(checkManifest(merged('<uses-permission-sdk-23 android:name="android.permission.READ_SMS" />')).length, 1);
});

test("accessibility anywhere fails", () => {
  const svc = '<service android:name="x.A11y" android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE" android:exported="false" />';
  assert.deepEqual(checkManifest(merged("", svc)), ["FAIL accessibility service present"]);
});

test("the listener service must exist, be exported=false and need BIND_NOTIFICATION_LISTENER_SERVICE", () => {
  assert.ok(checkManifest(merged("", "", "")).includes("FAIL CollectionListenerService missing"));
  assert.ok(checkManifest(merged("", "", moduleService.replace('exported="false"', 'exported="true"'))).some((f: string) => /exported/.test(f)));
  assert.ok(
    checkManifest(merged("", "", moduleService.replace("BIND_NOTIFICATION_LISTENER_SERVICE", "BIND_JOB_SERVICE"))).some((f: string) =>
      /BIND_NOTIFICATION_LISTENER_SERVICE/.test(f),
    ),
  );
});

test("a missing <queries> package fails", () => {
  const f = checkManifest(merged("", "", moduleService, moduleQueries.replace(/<package android:name="com\.etisalat\.flous" \/>/, "")));
  assert.deepEqual(f, ["FAIL <queries> lacks com.etisalat.flous"]);
});

test("a new foreground service (type or permission) fails; the baseline does not", () => {
  const svc = '<service android:name="x.Sync" android:exported="false" android:foregroundServiceType="dataSync" />';
  assert.deepEqual(checkManifest(merged("", svc)), ["FAIL new foreground service x.Sync (dataSync)"]);
  const loc = checkManifest(merged('<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />'));
  assert.deepEqual(loc, [], "FOREGROUND_SERVICE_LOCATION rides with expo-location's baseline service");
  const cam = checkManifest(merged('<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CAMERA" />'));
  assert.deepEqual(cam, ["FAIL new foreground service permission android.permission.FOREGROUND_SERVICE_CAMERA"]);
});

test("comments never count (a commented-out RECEIVE_SMS is fine)", () => {
  assert.deepEqual(checkManifest(merged('<!-- <uses-permission android:name="android.permission.RECEIVE_SMS"/> -->')), []);
});
