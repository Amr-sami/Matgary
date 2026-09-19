/**
 * Unit tests for the universal-link → app-route mapper.
 *
 * Run:  node --test --experimental-strip-types apps/mobile/src/app/__tests__/native-intent.test.ts
 *
 * Lives under `__tests__/` on purpose: Metro's default blockList excludes
 * `/__tests__/` so Expo Router never treats this file as a route (the
 * require.context in expo-router/_ctx.ios.js otherwise matches every .ts
 * under app/). `+native-intent.ts` has no imports, so plain Node can load it.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";

// Node's type-stripping loader needs the explicit `.ts` extension; the Expo
// tsconfig has no `allowImportingTsExtensions`, so silence that one check —
// Metro never bundles this file (see header) and tsc still checks everything
// the import brings in.
// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import { mapWebPathToAppRoute, parseLink, redirectSystemPath, resolveSystemPath, stripLocalePrefix } from "../+native-intent.ts";

// A realistic token: URL-safe base64 with the characters that a careless
// decode/re-encode round-trip would mangle.
const TOKEN = "Ab3-_Zq9%2Bx%3D%3D.tail";

test("reset-password: keeps the token byte-for-byte, drops the locale", () => {
  for (const loc of ["ar", "en"]) {
    assert.equal(
      mapWebPathToAppRoute(`https://thestoro.com/${loc}/reset-password?token=${TOKEN}`),
      `/reset-password?token=${TOKEN}`,
    );
    assert.equal(
      mapWebPathToAppRoute(`/${loc}/reset-password?token=${TOKEN}`),
      `/reset-password?token=${TOKEN}`,
    );
  }
});

test("reset-password: extra query params and fragments", () => {
  assert.equal(
    mapWebPathToAppRoute(`https://thestoro.com/ar/reset-password?token=${TOKEN}&utm_source=mail#x`),
    `/reset-password?token=${TOKEN}&utm_source=mail`,
  );
  // No token at all — still lands on the screen, which shows its invalid state.
  assert.equal(mapWebPathToAppRoute("https://thestoro.com/en/reset-password"), "/reset-password");
  // Trailing slash tolerated.
  assert.equal(
    mapWebPathToAppRoute(`https://thestoro.com/ar/reset-password/?token=${TOKEN}`),
    `/reset-password?token=${TOKEN}`,
  );
});

test("login / forgot-password / signup map 1:1 and shed web-only query params", () => {
  assert.equal(mapWebPathToAppRoute("https://thestoro.com/ar/login"), "/login");
  assert.equal(mapWebPathToAppRoute("https://thestoro.com/en/login?callbackUrl=%2Far%2Fsales"), "/login");
  assert.equal(mapWebPathToAppRoute("/login"), "/login");
  assert.equal(mapWebPathToAppRoute("/en/forgot-password"), "/forgot-password");
  assert.equal(mapWebPathToAppRoute("https://thestoro.com/ar/signup"), "/signup");
});

test("whatsapp, settings/*, team/* pass through", () => {
  assert.equal(mapWebPathToAppRoute("https://thestoro.com/whatsapp"), "/whatsapp");
  assert.equal(mapWebPathToAppRoute("/ar/whatsapp"), "/whatsapp");
  assert.equal(mapWebPathToAppRoute("https://thestoro.com/settings"), "/settings");
  assert.equal(mapWebPathToAppRoute("https://thestoro.com/settings/digest"), "/settings/digest");
  assert.equal(mapWebPathToAppRoute("https://thestoro.com/en/settings/printers/"), "/settings/printers");
  assert.equal(mapWebPathToAppRoute("https://thestoro.com/team"), "/team");
  assert.equal(mapWebPathToAppRoute("https://thestoro.com/team/attendance"), "/team/attendance");
});

test("root and unknown paths collapse to /", () => {
  assert.equal(mapWebPathToAppRoute("https://thestoro.com/"), "/");
  assert.equal(mapWebPathToAppRoute("https://thestoro.com"), "/");
  assert.equal(mapWebPathToAppRoute("https://thestoro.com/ar"), "/");
  assert.equal(mapWebPathToAppRoute("https://thestoro.com/en/"), "/");
  assert.equal(mapWebPathToAppRoute("https://thestoro.com/ar/blog/some-post"), "/");
  assert.equal(mapWebPathToAppRoute("https://thestoro.com/billing?x=1"), "/");
  assert.equal(mapWebPathToAppRoute("https://thestoro.com/settingsx"), "/");
  assert.equal(mapWebPathToAppRoute("https://thestoro.com/teamwork"), "/");
  assert.equal(mapWebPathToAppRoute(""), "/");
  assert.equal(mapWebPathToAppRoute("   "), "/");
});

test("locale strip only removes a whole /ar or /en segment", () => {
  assert.equal(stripLocalePrefix("/ar/login"), "/login");
  assert.equal(stripLocalePrefix("/EN/login"), "/login");
  assert.equal(stripLocalePrefix("/arabic/login"), "/arabic/login");
  assert.equal(stripLocalePrefix("/english"), "/english");
  assert.equal(stripLocalePrefix("/ar"), "/");
  assert.equal(stripLocalePrefix("/"), "/");
  // Only the first segment — a second /ar is content, not locale.
  assert.equal(stripLocalePrefix("/ar/ar"), "/ar");
});

test("parseLink: hosts, ports, custom schemes", () => {
  assert.deepEqual(parseLink("https://thestoro.com:443/ar/login?x=1#frag"), {
    scheme: "https",
    host: "thestoro.com:443",
    pathname: "/ar/login",
    search: "?x=1",
  });
  assert.deepEqual(parseLink("http://127.0.0.1:3003?token=a"), {
    scheme: "http",
    host: "127.0.0.1:3003",
    pathname: "/",
    search: "?token=a",
  });
  assert.deepEqual(parseLink("matgary://reset-password?token=a"), {
    scheme: "matgary",
    host: "",
    pathname: "/reset-password",
    search: "?token=a",
  });
  assert.deepEqual(parseLink("matgary:///reset-password?token=a"), {
    scheme: "matgary",
    host: "",
    pathname: "/reset-password",
    search: "?token=a",
  });
  // Custom schemes keep the host inside the path (Expo does the same) — the
  // whole thing is passed through untouched by resolveSystemPath anyway.
  assert.deepEqual(parseLink("exp://192.168.1.5:8081/--/reset-password?token=a"), {
    scheme: "exp",
    host: "",
    pathname: "/192.168.1.5:8081/--/reset-password",
    search: "?token=a",
  });
  assert.equal(parseLink("//a///b//").pathname, "/a/b");
});

test("resolveSystemPath: web URLs are mapped, custom-scheme URLs untouched", () => {
  assert.equal(
    resolveSystemPath(`https://thestoro.com/ar/reset-password?token=${TOKEN}`),
    `/reset-password?token=${TOKEN}`,
  );
  assert.equal(resolveSystemPath(`/en/login`), "/login");

  // Expo Router's own URLs must survive verbatim — including the home-screen
  // launch root URL and the dev-client boot URL.
  for (const u of [
    "matgary:///",
    "matgary://",
    `matgary://reset-password?token=${TOKEN}`,
    `matgary:///reset-password?token=${TOKEN}`,
    "matgary://inventory/42",
    "matgary://expo-development-client/?url=http%3A%2F%2F192.168.1.5%3A8081",
    "com.thestoro.app://settings/digest",
    "exp://192.168.1.5:8081/--/sales",
  ]) {
    assert.equal(resolveSystemPath(u), u, u);
  }
});

test("resolveSystemPath: locale segment is stripped from custom-scheme URLs too", () => {
  assert.equal(
    resolveSystemPath(`matgary://ar/reset-password?token=${TOKEN}`),
    `matgary://reset-password?token=${TOKEN}`,
  );
  assert.equal(
    resolveSystemPath(`matgary:///en/reset-password?token=${TOKEN}`),
    `matgary://reset-password?token=${TOKEN}`,
  );
  assert.equal(resolveSystemPath("matgary://ar"), "matgary://");
});

test("redirectSystemPath never throws and returns a string", () => {
  assert.equal(
    redirectSystemPath({ path: `https://thestoro.com/en/reset-password?token=${TOKEN}`, initial: true }),
    `/reset-password?token=${TOKEN}`,
  );
  assert.equal(redirectSystemPath({ path: "matgary:///", initial: true }), "matgary:///");
  // Garbage input: falls back to the input rather than crashing at launch.
  // @ts-expect-error — deliberately wrong type
  assert.equal(redirectSystemPath({ path: null, initial: true }), "/");
  // @ts-expect-error — deliberately wrong type
  const r = redirectSystemPath({ path: 42, initial: false });
  assert.equal(typeof r, "string");
});
