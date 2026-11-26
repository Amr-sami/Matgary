/**
 * Run:  cd apps/mobile && npx tsx --test modules/collection-listener/__tests__/index.test.ts
 *
 * Doc 15 spec 11 §7.2 (index.test.ts row) + §6 criterion 1: without the native module (plain Node,
 * iOS) `isSupported() === false`, `isAccessGranted()` → false, `getStatus()` → the zero status,
 * `requestRebind()` / `openAccessSettings()` / `openBatterySettings()` → false, `clearCredentials()`
 * resolves, `configure()` rejects `UNAVAILABLE`, nothing throws at import. With a fake native side:
 * the token never comes back, NOT_CONFIGURED propagates, odd native answers are contained.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension (same convention as the node --test suites)
import * as L from "../index.ts";

const TOKEN = "mgi_" + "A".repeat(20) + "_-" + "b9".repeat(10) + "z";
const CFG = {
  ingestUrl: "https://thestoro.com/api/v1/collections/ingest",
  token: TOKEN,
  packages: ["com.egyptianbanks.instapay"],
  keywords: { ar: ["استلام"], en: ["IPN"] },
  otpPatterns: ["otp"],
  configVersion: "v1",
};

test("plain Node: no native module → zero values, configure rejects UNAVAILABLE, nothing throws", async () => {
  L.__setNativeForTests(undefined); // the real lazy load (expo-modules-core is not loadable here)
  assert.equal(L.isListenerModuleAvailable(), false);
  assert.equal(L.isSupported(), false);
  assert.equal(await L.isAccessGranted(), false);
  assert.deepEqual(await L.getStatus(), {
    configured: false,
    connected: false,
    lastNotificationAt: null,
    lastUploadAt: null,
    queued: 0,
    packagesInstalled: [],
  });
  assert.equal(await L.requestRebind(), false);
  assert.equal(await L.openAccessSettings(), false);
  assert.equal(await L.openBatterySettings(), false);
  assert.equal(await L.clearCredentials(), undefined);
  await assert.rejects(L.configure(CFG), (e: unknown) => L.listenerErrorCode(e) === "UNAVAILABLE");
  // No __DEV__ in plain Node → the console harness is not installed.
  assert.equal((globalThis as Record<string, unknown>).__collectionListener, undefined);
});

test("the zero status is a fresh object each time (callers may mutate it)", async () => {
  L.__setNativeForTests(null);
  const a = await L.getStatus();
  a.packagesInstalled.push("x");
  assert.deepEqual((await L.getStatus()).packagesInstalled, []);
});

function fake(over: Partial<Record<string, unknown>> = {}) {
  const calls: { fn: string; arg?: unknown }[] = [];
  const base = {
    isSupported: () => true,
    isAccessGranted: async () => true,
    openAccessSettings: async () => true,
    configure: async (c: unknown) => {
      calls.push({ fn: "configure", arg: c });
    },
    getStatus: async () => ({
      configured: true,
      connected: true,
      lastNotificationAt: "2026-10-19T08:00:00.000Z",
      lastUploadAt: null,
      queued: 2,
      packagesInstalled: ["com.egyptianbanks.instapay"],
      token: TOKEN, // a buggy native side must not leak it through getStatus
    }),
    requestRebind: async () => true,
    clearCredentials: async () => {
      calls.push({ fn: "clearCredentials" });
    },
    openBatterySettings: async () => true,
    ...over,
  };
  return { calls, mod: base as never };
}

test("with the module: status is whitelisted (no token field), configure passes plain arrays", async () => {
  const f = fake();
  L.__setNativeForTests(f.mod);
  try {
    assert.equal(L.isSupported(), true);
    const s = await L.getStatus();
    assert.deepEqual(Object.keys(s).sort(), ["configured", "connected", "lastNotificationAt", "lastUploadAt", "packagesInstalled", "queued"]);
    assert.equal(JSON.stringify(s).includes("mgi_"), false);
    assert.equal(s.queued, 2);
    await L.configure({ ...CFG, packages: Object.freeze([...CFG.packages]) });
    assert.deepEqual(f.calls[0], { fn: "configure", arg: { ...CFG } });
    await L.clearCredentials();
    assert.equal(f.calls[1].fn, "clearCredentials");
  } finally {
    L.__setNativeForTests(null);
  }
});

test("openAccessSettings: NOT_CONFIGURED propagates, any other failure → false", async () => {
  L.__setNativeForTests(fake({ openAccessSettings: async () => { throw L.listenerError("NOT_CONFIGURED"); } }).mod);
  try {
    await assert.rejects(L.openAccessSettings(), (e: unknown) => L.listenerErrorCode(e) === "NOT_CONFIGURED");
  } finally {
    L.__setNativeForTests(null);
  }
  L.__setNativeForTests(fake({ openAccessSettings: async () => { throw new Error("ActivityNotFound"); } }).mod);
  try {
    assert.equal(await L.openAccessSettings(), false);
  } finally {
    L.__setNativeForTests(null);
  }
});

test("configure: the module's codes survive, anything else is UNAVAILABLE and never echoes the token", async () => {
  for (const code of ["INVALID_CONFIG", "KEYSTORE_FAILED"] as const) {
    L.__setNativeForTests(fake({ configure: async () => { throw L.listenerError(code, "boom " + TOKEN); } }).mod);
    try {
      await assert.rejects(L.configure(CFG), (e: unknown) => {
        assert.equal(L.listenerErrorCode(e), code);
        assert.equal(String((e as Error).message).includes("mgi_"), false);
        return true;
      });
    } finally {
      L.__setNativeForTests(null);
    }
  }
  L.__setNativeForTests(fake({ configure: async () => { throw new Error("weird " + TOKEN); } }).mod);
  try {
    await assert.rejects(L.configure(CFG), (e: unknown) => L.listenerErrorCode(e) === "UNAVAILABLE" && !String((e as Error).message).includes("mgi_"));
  } finally {
    L.__setNativeForTests(null);
  }
});

test("a throwing or odd native side is contained", async () => {
  const boom = async () => {
    throw new Error("native exploded");
  };
  L.__setNativeForTests(
    fake({
      isSupported: () => {
        throw new Error("x");
      },
      isAccessGranted: boom,
      getStatus: async () => ({ queued: -3, packagesInstalled: [1, "a.b"], connected: "yes", lastUploadAt: 5 }),
      requestRebind: boom,
      clearCredentials: boom,
      openBatterySettings: async () => "true",
    }).mod,
  );
  try {
    assert.equal(L.isSupported(), false);
    assert.equal(await L.isAccessGranted(), false);
    assert.deepEqual(await L.getStatus(), {
      configured: false,
      connected: false,
      lastNotificationAt: null,
      lastUploadAt: null,
      queued: 0,
      packagesInstalled: ["a.b"],
    });
    assert.equal(await L.requestRebind(), false);
    assert.equal(await L.clearCredentials(), undefined);
    assert.equal(await L.openBatterySettings(), false);
  } finally {
    L.__setNativeForTests(null);
  }
});
