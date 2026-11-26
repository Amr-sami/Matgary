/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/offline/__tests__/alert-origin.test.ts
 *
 * Doc 16 §2/§12 — the X-Alert-Origin header is sent only when this install
 * has an Expo push token, and the outbox replay adds X-Outbox-Replay: 1.
 * The header names are pinned against the server routes that read them.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import { ALERT_ORIGIN_HEADER, OUTBOX_REPLAY_HEADER, alertOriginHeader, outboxReplayHeaders } from "../alert-origin.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CART_ROUTE = resolve(here, "../../../../../apps/web/app/api/sales/cart/route.ts");

test("the header is present only when a token exists", () => {
  assert.deepEqual(alertOriginHeader("ExponentPushToken[abc123]"), {
    "X-Alert-Origin": "ExponentPushToken[abc123]",
  });
  assert.deepEqual(alertOriginHeader(" ExpoPushToken[x] "), { "X-Alert-Origin": "ExpoPushToken[x]" });
  for (const none of [null, undefined, "", "   ", "not-a-token", "ExponentPushToken[]", "fcm:abc"]) {
    assert.deepEqual(alertOriginHeader(none), {}, String(none));
  }
});

test("the outbox replay always says so, and adds the origin when there is one", () => {
  assert.deepEqual(outboxReplayHeaders(null), { "X-Outbox-Replay": "1" });
  assert.deepEqual(outboxReplayHeaders("ExponentPushToken[abc]"), {
    "X-Alert-Origin": "ExponentPushToken[abc]",
    "X-Outbox-Replay": "1",
  });
});

test("the header names match what the cart route reads", () => {
  const src = readFileSync(CART_ROUTE, "utf8");
  assert.ok(src.includes(`"${ALERT_ORIGIN_HEADER}"`), "cart route no longer reads X-Alert-Origin");
  assert.ok(src.includes(`"${OUTBOX_REPLAY_HEADER}"`), "cart route no longer reads X-Outbox-Replay");
});
