/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/lib/__tests__/notification-routes.test.ts
 *
 * Doc 15 spec 13 §7 T9 — the notification routing registry, moved out of
 * NotificationBell.tsx so plain Node can load it (it imports types only).
 * Covers the collection routes (inbox query kept and filtered, detail and
 * credit detail, the settings screens), the gates (view_collections for the
 * inbox, manage_collection_accounts — not view_settings — for the collection
 * settings), the silent-phone override, and regressions on the old routes.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MeResponse } from "@matgary/api-client";
// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import { KIND_ROUTE, KIND_ROUTE_OVERRIDE, canOpenRoute, routeForNotification, toAppRoute } from "../notification-routes.ts";

function me(permissions: string[], isOwner = false): MeResponse {
  return { isOwner, permissions } as unknown as MeResponse;
}
const OWNER = me([], true);
const CASHIER = me(["record_sales", "view_sales"]);
const VIEWER = me(["record_sales", "view_collections"]);
const ACCOUNTS = me(["manage_collection_accounts"]);
const SETTINGS_ONLY = me(["view_settings"]);

test("toAppRoute: the inbox keeps a filtered tab|status|stale query, in that order", () => {
  assert.equal(toAppRoute("/collections?status=pending&stale=1"), "/collections?status=pending&stale=1");
  assert.equal(toAppRoute("/collections?stale=1&status=pending"), "/collections?status=pending&stale=1");
  assert.equal(toAppRoute("/collections?tab=credits&x=1"), "/collections?tab=credits");
  assert.equal(
    toAppRoute("/collections?tab=totals&account=0f9d&warning=day_80"),
    "/collections?tab=totals",
  );
  assert.equal(toAppRoute("/collections"), "/collections");
  assert.equal(toAppRoute("/collections?"), "/collections");
  // Values outside the allowed sets are dropped, not passed through.
  assert.equal(toAppRoute("/collections?tab=evil&status=confirmed&stale=0"), "/collections");
  assert.equal(toAppRoute("/collections?tab=pending#frag"), "/collections?tab=pending");
  assert.equal(toAppRoute("/(app)/collections?status=pending"), "/collections?status=pending");
  // Malformed escapes never throw.
  assert.equal(toAppRoute("/collections?tab=%E0%A4%A&status=pending"), "/collections?status=pending");
});

test("toAppRoute: collection detail and credit detail", () => {
  assert.equal(toAppRoute("/collections/abc"), "/collections/abc");
  assert.equal(toAppRoute("/collections/abc?stale=1"), "/collections/abc");
  assert.equal(toAppRoute("/collections/credit/xyz"), "/collections/credit/xyz");
  assert.equal(toAppRoute("/collections/credit"), "/collections");
});

test("toAppRoute: collection settings screens", () => {
  assert.equal(toAppRoute("/settings/collections"), "/settings/collections");
  assert.equal(toAppRoute("/settings/collections/devices"), "/settings/collections/devices");
  assert.equal(toAppRoute("/settings/collections/automation"), "/settings/collections/automation");
  assert.equal(toAppRoute("/settings/collections/account/new"), "/settings/collections/account/new");
  assert.equal(toAppRoute("/settings/collections/account"), "/settings/collections");
  assert.equal(toAppRoute("/settings/collections/zzz"), "/settings/collections");
});

test("toAppRoute: regressions on the existing routes", () => {
  assert.equal(toAppRoute("/purchases/abc"), "/purchases");
  assert.equal(toAppRoute("/inventory?low=1"), "/inventory");
  assert.equal(toAppRoute("/inventory/p1"), "/inventory/p1");
  assert.equal(toAppRoute("/settings/digest"), "/settings/digest");
  assert.equal(toAppRoute("/settings/unknown"), "/settings");
  assert.equal(toAppRoute("/sales"), "/sales");
  assert.equal(toAppRoute("/"), "/");
  assert.equal(toAppRoute("/nowhere"), null);
  assert.equal(toAppRoute(null), null);
  assert.equal(toAppRoute(""), null);
});

test("canOpenRoute: the inbox needs view_collections; the query is ignored", () => {
  assert.equal(canOpenRoute("/collections?status=pending&stale=1", OWNER), true);
  assert.equal(canOpenRoute("/collections?status=pending&stale=1", VIEWER), true);
  assert.equal(canOpenRoute("/collections", CASHIER), false);
  assert.equal(canOpenRoute("/collections/abc", CASHIER), false);
  assert.equal(canOpenRoute("/inventory?low=1", CASHIER), true);
  assert.equal(canOpenRoute("/collections", null), false);
});

test("canOpenRoute: collection settings need manage_collection_accounts, not view_settings", () => {
  assert.equal(canOpenRoute("/settings/collections/devices", ACCOUNTS), true);
  assert.equal(canOpenRoute("/settings/collections", ACCOUNTS), true);
  assert.equal(canOpenRoute("/settings/collections/devices", SETTINGS_ONLY), false);
  assert.equal(canOpenRoute("/settings/collections/devices", OWNER), true);
  // The rest of settings keeps its view_settings gate.
  assert.equal(canOpenRoute("/settings/digest", ACCOUNTS), false);
  assert.equal(canOpenRoute("/settings/digest", SETTINGS_ONLY), true);
});

test("routeForNotification: kinds, override and gates", () => {
  // The silent-phone alert beats its web link and opens the devices screen.
  assert.equal(
    routeForNotification({ kind: "collection_source_silent", link: "/settings/collections" }, OWNER),
    "/settings/collections/devices",
  );
  assert.equal(
    routeForNotification({ kind: "collection_source_silent", link: null }, ACCOUNTS),
    "/settings/collections/devices",
  );
  assert.equal(routeForNotification({ kind: "collection_source_silent", link: null }, VIEWER), null);
  assert.equal(
    routeForNotification({ kind: "collection_stale", link: "/collections?status=pending&stale=1" }, VIEWER),
    "/collections?status=pending&stale=1",
  );
  assert.equal(
    routeForNotification({ kind: "collection_unmatched", link: "/collections?tab=credits" }, OWNER),
    "/collections?tab=credits",
  );
  assert.equal(
    routeForNotification(
      { kind: "collection_limit", link: "/collections?tab=totals&account=a1&warning=day_80" },
      OWNER,
    ),
    "/collections?tab=totals",
  );
  // No link → the kind table.
  assert.equal(routeForNotification({ kind: "collection_pending", link: null }, OWNER), "/collections");
  // A cashier never lands on a 403 screen.
  assert.equal(routeForNotification({ kind: "collection_pending", link: "/collections" }, CASHIER), null);
  // Regressions.
  assert.equal(routeForNotification({ kind: "low_stock", link: null }, CASHIER), "/inventory");
  assert.equal(routeForNotification({ kind: "info", link: null }, OWNER), null);
  assert.equal(routeForNotification({ kind: "info", link: "/team" }, CASHIER), null);
});

test("the kind tables cover the five collection kinds", () => {
  assert.deepEqual(
    [
      KIND_ROUTE.collection_pending,
      KIND_ROUTE.collection_stale,
      KIND_ROUTE.collection_unmatched,
      KIND_ROUTE.collection_limit,
      KIND_ROUTE.collection_source_silent,
    ],
    ["/collections", "/collections", "/collections", "/collections", "/settings/collections/devices"],
  );
  assert.deepEqual(KIND_ROUTE_OVERRIDE, { collection_source_silent: "/settings/collections/devices" });
});
