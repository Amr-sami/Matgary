/**
 * Run:  node --test --experimental-strip-types apps/web/app/.well-known/_lib/app-links.test.ts
 *
 * Kept next to the builder (the `_lib` folder is private to Next.js, so it is
 * never a route) and runnable with plain Node because the builder has no
 * framework imports. vitest's include glob is tests/**, so this is deliberately
 * outside it — the route handlers are exercised live with curl instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  APP_BUNDLE_ID,
  UNIVERSAL_LINK_PATHS,
  buildAppleAppSiteAssociation,
  buildAssetLinks,
  parseSha256Fingerprints,
  parseTeamId,
} from "./app-links.ts";

const FP_A = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
const FP_B = "01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF";

test("parseTeamId accepts only the 10-char Apple form", () => {
  assert.equal(parseTeamId("ABCDE12345"), "ABCDE12345");
  assert.equal(parseTeamId("  abcde12345 "), "ABCDE12345");
  for (const bad of [undefined, null, "", "TODO", "ABCDE1234", "ABCDE123456", "ABCDE1234!", "ABCDE12345.com.thestoro.app"]) {
    assert.equal(parseTeamId(bad), null, String(bad));
  }
});

test("apple-app-site-association: not configured → hint, never a placeholder", () => {
  for (const raw of [undefined, "", "TEAMID", "REPLACE_ME"]) {
    const r = buildAppleAppSiteAssociation(raw);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.hint, /APPLE_TEAM_ID/);
  }
});

test("apple-app-site-association: full shape with Team ID", () => {
  const r = buildAppleAppSiteAssociation("ABCDE12345");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const appId = `ABCDE12345.${APP_BUNDLE_ID}`;
  assert.equal(APP_BUNDLE_ID, "com.thestoro.app");
  assert.deepEqual(r.body, {
    applinks: {
      details: [
        {
          appIDs: [appId],
          components: [
            { "/": "/ar/reset-password*" },
            { "/": "/en/reset-password*" },
            { "/": "/ar/login*" },
            { "/": "/en/login*" },
          ],
        },
      ],
    },
    webcredentials: { apps: [appId] },
  });
  // Both locales, both flows — and nothing else on the domain.
  assert.equal(UNIVERSAL_LINK_PATHS.length, 4);
  assert.ok(UNIVERSAL_LINK_PATHS.every((p) => /^\/(ar|en)\/(reset-password|login)\*$/.test(p)));
  // JSON-serialisable and well under Apple's 128 KB cap.
  assert.ok(JSON.stringify(r.body).length < 128 * 1024);
});

test("parseSha256Fingerprints: comma/space separated, upper-cased, deduped, junk dropped", () => {
  assert.deepEqual(parseSha256Fingerprints(undefined), []);
  assert.deepEqual(parseSha256Fingerprints(""), []);
  assert.deepEqual(parseSha256Fingerprints("not-a-fingerprint"), []);
  assert.deepEqual(parseSha256Fingerprints(FP_A), [FP_A]);
  assert.deepEqual(parseSha256Fingerprints(`${FP_A.toLowerCase()}, ${FP_B}`), [FP_A, FP_B]);
  assert.deepEqual(parseSha256Fingerprints(` ${FP_A} ;${FP_A}\n${FP_B} ,garbage`), [FP_A, FP_B]);
  // 31 bytes is not a SHA-256.
  assert.deepEqual(parseSha256Fingerprints(FP_A.slice(3)), []);
});

test("assetlinks.json: not configured → hint", () => {
  for (const raw of [undefined, "", "TODO", "AA:BB"]) {
    const r = buildAssetLinks(raw);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.hint, /ANDROID_SHA256_CERT_FINGERPRINTS/);
  }
});

test("assetlinks.json: full shape with fingerprints", () => {
  const r = buildAssetLinks(`${FP_A},${FP_B}`);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.body, [
    {
      relation: [
        "delegate_permission/common.handle_all_urls",
        "delegate_permission/common.get_login_creds",
      ],
      target: {
        namespace: "android_app",
        package_name: "com.thestoro.app",
        sha256_cert_fingerprints: [FP_A, FP_B],
      },
    },
  ]);
});
