/**
 * Run:  cd apps/mobile && npx tsx --test modules/collections-ingest/__tests__/index.test.ts
 *
 * Doc 15 spec 10 §7.1 (index.test.ts row): in plain Node every export resolves `false` / `null`
 * and never throws (no native module, no `__DEV__`); `setIngestCredential` refuses a token that is
 * not `^mgi_[A-Za-z0-9_-]{43}$` and a non-https URL (outside `__DEV__`) WITHOUT calling native.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension (same convention as the node --test suites)
import * as m from "../index.ts";

const TOKEN = "mgi_" + "A".repeat(20) + "_-" + "b9".repeat(10) + "z"; // 4 + 43
const URL_OK = "https://thestoro.com/api/v1/collections/ingest";

test("token fixture has 07's shape", () => {
  assert.equal(TOKEN.length, 47);
  assert.ok(m.isValidIngestToken(TOKEN));
});

test("plain Node: no native module → every export resolves false/null and never throws", async () => {
  m.__setNativeForTests(undefined); // force the real lazy load (expo-modules-core is not loadable here)
  assert.equal(m.isCollectionsIngestAvailable(), false);
  assert.equal(await m.setIngestCredential({ url: URL_OK, token: TOKEN }), false);
  assert.equal(await m.hasIngestCredential(), false);
  assert.equal(await m.clearIngestCredential(), false);
  assert.equal(await m.getIngestStatus(), null);
  assert.equal(await m.forwardForTesting({ text: "THESTORO-SETUP-TEST" }), null);
  // Garbage in never throws either.
  assert.equal(await m.setIngestCredential(null as never), false);
  assert.equal(await m.setIngestCredential({} as never), false);
  assert.equal(await m.forwardForTesting(null as never), null);
});

test("token shape: exactly mgi_ + 43 base64url characters", () => {
  for (const bad of ["", "mgi_", "mgi_short", TOKEN + "x", TOKEN.slice(0, -1), "mgx_" + TOKEN.slice(4),
    "mgi_" + "A".repeat(42) + "=", "mgi_" + "A".repeat(42) + "+", " " + TOKEN, TOKEN + "\n", 42, null, undefined]) {
    assert.equal(m.isValidIngestToken(bad), false, JSON.stringify(bad));
  }
});

test("URL rule: https always; http only in a dev bundle; no credentials, query or fragment", () => {
  assert.ok(m.isValidIngestUrl(URL_OK, false));
  assert.ok(m.isValidIngestUrl("http://192.168.1.20:3003/api/v1/collections/ingest", true));
  assert.equal(m.isValidIngestUrl("http://192.168.1.20:3003/api/v1/collections/ingest", false), false);
  assert.equal(m.isValidIngestUrl("http://192.168.1.20:3003/api/v1/collections/ingest"), false, "plain Node is not __DEV__");
  for (const bad of ["ftp://thestoro.com/x", "thestoro.com/api", "https://", "https://u:p@thestoro.com/x",
    "https://thestoro.com/x?t=1", "https://thestoro.com/x#a", "javascript:alert(1)", "", 7, null]) {
    assert.equal(m.isValidIngestUrl(bad, true), false, JSON.stringify(bad));
  }
});

test("setIngestCredential validates BEFORE native: a bad token or URL never reaches the Keychain", async () => {
  const calls: string[] = [];
  m.__setNativeForTests({
    setCredential: async (url: string, token: string) => (calls.push(`${url} ${token}`), true),
    hasCredential: async () => true,
    clearCredential: async () => true,
    getStatus: async () => null,
  });
  try {
    assert.equal(await m.setIngestCredential({ url: URL_OK, token: "mgi_nope" }), false);
    assert.equal(await m.setIngestCredential({ url: "http://thestoro.com/api/v1/collections/ingest", token: TOKEN }), false);
    assert.deepEqual(calls, [], "native was called for an invalid credential");
    assert.equal(await m.setIngestCredential({ url: URL_OK, token: TOKEN }), true);
    assert.deepEqual(calls, [`${URL_OK} ${TOKEN}`]);
  } finally {
    m.__setNativeForTests(null);
  }
});

test("a throwing or odd native side is contained", async () => {
  const boom = async () => {
    throw new Error("native exploded");
  };
  m.__setNativeForTests({ setCredential: boom, hasCredential: boom, clearCredential: boom, getStatus: boom });
  try {
    assert.equal(m.isCollectionsIngestAvailable(), true);
    assert.equal(await m.setIngestCredential({ url: URL_OK, token: TOKEN }), false);
    assert.equal(await m.hasIngestCredential(), false);
    assert.equal(await m.clearIngestCredential(), false);
    assert.equal(await m.getIngestStatus(), null);
  } finally {
    m.__setNativeForTests(null);
  }
  m.__setNativeForTests({
    setCredential: async () => "yes" as never,
    hasCredential: async () => 1 as never,
    clearCredential: async () => true,
    getStatus: async () => ({ hasCredential: true, queued: Number.NaN, lastUploadAt: 5, lastError: "HTTP_503", configVersion: "abc" }) as never,
    forwardForTesting: async () => "sent",
  });
  try {
    assert.equal(await m.setIngestCredential({ url: URL_OK, token: TOKEN }), false, "only a literal true counts");
    assert.equal(await m.hasIngestCredential(), false);
    assert.deepEqual(await m.getIngestStatus(), {
      hasCredential: true, queued: 0, lastUploadAt: null, lastError: "HTTP_503", configVersion: "abc",
    });
    assert.equal(await m.forwardForTesting({ text: "x" }), null, "not __DEV__ in plain Node → never reaches native");
  } finally {
    m.__setNativeForTests(null);
  }
});
