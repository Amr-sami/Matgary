/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/lib/__tests__/sale-alerts.test.ts
 *
 * Doc 16 §4-§7, §12 — the phone side of sale alerts:
 *  - payload → kind, tap route and refresh keys (single / summary / test /
 *    the local preview; anything else is not a sale alert);
 *  - the preview's channel (Android) and sound;
 *  - the settings switch: the PUT body and the row split;
 *  - parity: the channel and sound names agree across PushRegistrar.tsx,
 *    app.config.ts, the server's sale-alerts.ts, and the shipped wav file.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import { SALE_ALERT_CHANNEL, SALE_ALERT_REFRESH_KEYS, SALE_ALERT_SOUND, previewNotificationRequest, refreshKeysFor, saleAlertKind, saleAlertPreferenceBody, saleAlertTapRoute, splitSaleAlertRow } from "../sale-alerts.ts";
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import { toAppRoute } from "../notification-routes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(here, "../../..");
const REPO = resolve(MOBILE, "../..");
const LINE = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("kind: the four data.type values, nothing else", () => {
  assert.equal(saleAlertKind({ type: "sale_alert", route: `/sales/${LINE}` }), "single");
  assert.equal(saleAlertKind({ type: "sale_alert_summary" }), "summary");
  assert.equal(saleAlertKind({ type: "sale_alert_test" }), "test");
  assert.equal(saleAlertKind({ type: "sale_alert_preview" }), "preview");
  for (const d of [null, undefined, "sale_alert", {}, { type: 1 }, { type: "collection_pending" }, { type: "sale_alert_x" }]) {
    assert.equal(saleAlertKind(d), null, JSON.stringify(d));
  }
});

test("tap: a sale opens its line, the rest open Sales history, the preview stays put", () => {
  assert.equal(saleAlertTapRoute({ type: "sale_alert", route: `/sales/${LINE}` }, toAppRoute), `/sales/${LINE}`);
  assert.equal(saleAlertTapRoute({ type: "sale_alert_summary", route: "/sales/history" }, toAppRoute), "/sales/history");
  assert.equal(saleAlertTapRoute({ type: "sale_alert_test", route: "/sales/history" }, toAppRoute), "/sales/history");
  // No inbox row exists for a sale alert: a missing or foreign route falls
  // back to history, never to /notifications.
  assert.equal(saleAlertTapRoute({ type: "sale_alert" }, toAppRoute), "/sales/history");
  assert.equal(saleAlertTapRoute({ type: "sale_alert", route: "/nowhere" }, toAppRoute), "/sales/history");
  assert.equal(saleAlertTapRoute({ type: "sale_alert", route: "/team/x" }, toAppRoute), "/sales/history");
  assert.equal(saleAlertTapRoute({ type: "sale_alert", route: "/sales" }, toAppRoute), "/sales/history");
  assert.equal(saleAlertTapRoute({ type: "sale_alert_preview" }, toAppRoute), null);
  // Not a sale alert → undefined, so the registrar's normal routing applies.
  assert.equal(saleAlertTapRoute({ type: "collection_pending", route: "/collections" }, toAppRoute), undefined);
  assert.equal(saleAlertTapRoute(null, toAppRoute), undefined);
});

test("refresh: a real sale invalidates Home and Sales history; test and preview do not", () => {
  assert.deepEqual(refreshKeysFor({ type: "sale_alert" }), SALE_ALERT_REFRESH_KEYS);
  assert.deepEqual(refreshKeysFor({ type: "sale_alert_summary" }), SALE_ALERT_REFRESH_KEYS);
  assert.deepEqual(SALE_ALERT_REFRESH_KEYS, [["dashboard"], ["sales", "history"]]);
  assert.deepEqual(refreshKeysFor({ type: "sale_alert_test" }), []);
  assert.deepEqual(refreshKeysFor({ type: "sale_alert_preview" }), []);
  assert.deepEqual(refreshKeysFor({ type: "low_stock" }), []);
});

test("the refresh keys are prefixes of the screens' real query keys", () => {
  const home = readFileSync(resolve(MOBILE, "src/app/(app)/index.tsx"), "utf8");
  const history = readFileSync(resolve(MOBILE, "src/app/(app)/sales/history.tsx"), "utf8");
  assert.match(home, /queryKey:\s*\["dashboard",/);
  assert.match(history, /queryKey:\s*\["sales",\s*"history",/);
});

test("preview: Android names the sales channel, iOS fires now with the bundled sound", () => {
  const copy = { title: "New sale · EGP 2,700", body: "Sound check" };
  const a = previewNotificationRequest("android", copy);
  assert.deepEqual(a.trigger, { channelId: "sales" });
  assert.equal(a.content.sound, "cha_ching.wav");
  assert.deepEqual(a.content.data, { type: "sale_alert_preview" });
  assert.equal(saleAlertKind(a.content.data), "preview");
  const i = previewNotificationRequest("ios", copy);
  assert.equal(i.trigger, null);
  assert.equal(i.content.sound, "cha_ching.wav");
  assert.equal(i.content.title, copy.title);
});

test("settings: the switch PUTs only push (the rest is the server's coerced shape)", () => {
  assert.deepEqual(saleAlertPreferenceBody(false), {
    eventType: "sale.alert",
    inApp: false,
    push: false,
    email: false,
    digestMode: "instant",
  });
  assert.equal(saleAlertPreferenceBody(true).push, true);
});

test("settings: sale.alert is pulled out of the per-event rows", () => {
  const rows = [{ eventType: "sale.created" }, { eventType: "sale.alert" }, { eventType: "inventory.low_stock" }];
  const { saleAlert, rest } = splitSaleAlertRow(rows);
  assert.deepEqual(saleAlert, { eventType: "sale.alert" });
  assert.deepEqual(rest.map((r) => r.eventType), ["sale.created", "inventory.low_stock"]);
  // A cashier without view_sales: the server does not list it → no card.
  assert.equal(splitSaleAlertRow([{ eventType: "sale.created" }]).saleAlert, null);
});

test("parity: channel and sound agree with PushRegistrar, app.config, the server and the asset", () => {
  assert.equal(SALE_ALERT_CHANNEL, "sales");
  assert.equal(SALE_ALERT_SOUND, "cha_ching.wav");
  const registrar = readFileSync(resolve(MOBILE, "src/effects/PushRegistrar.tsx"), "utf8");
  assert.match(registrar, /const SALES_CHANNEL[^=]*= "sales"/);
  assert.match(registrar, /const SALE_SOUND[^=]*= "cha_ching\.wav"/);
  const config = readFileSync(resolve(MOBILE, "app.config.ts"), "utf8");
  assert.ok(config.includes(`sounds: ["./assets/sounds/${SALE_ALERT_SOUND}"]`));
  assert.ok(existsSync(resolve(MOBILE, "assets/sounds", SALE_ALERT_SOUND)));
  const server = readFileSync(resolve(REPO, "apps/web/lib/notifications/sale-alerts.ts"), "utf8");
  assert.match(server, new RegExp(`SALE_ALERT_CHANNEL[^=]*=\\s*"${SALE_ALERT_CHANNEL}"`));
  assert.match(server, new RegExp(`SALE_ALERT_SOUND[^=]*=\\s*"${SALE_ALERT_SOUND.replace(".", "\\.")}"`));
});
