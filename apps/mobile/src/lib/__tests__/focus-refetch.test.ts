/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/lib/__tests__/focus-refetch.test.ts
 *
 * Audit T1 N-card: Home (a tab that stays mounted) kept its awaiting-transfers
 * count after sales were added elsewhere; returning to the tab must refetch a
 * stale dashboard, and only then.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import { FOCUS_REFETCH_STALE_MS, shouldRefetchOnFocus } from "../focus-refetch.ts";

const NOW = 1_760_000_000_000;

test("N-card: data fetched a minute ago, nothing in flight → refetch on focus", () => {
  assert.equal(shouldRefetchOnFocus({ dataUpdatedAt: NOW - 60_000, fetchStatus: "idle" }, NOW), true);
});

test("fresh data (younger than the app's staleTime) → no refetch", () => {
  assert.equal(shouldRefetchOnFocus({ dataUpdatedAt: NOW - 5_000, fetchStatus: "idle" }, NOW), false);
  assert.equal(shouldRefetchOnFocus({ dataUpdatedAt: NOW - FOCUS_REFETCH_STALE_MS, fetchStatus: "idle" }, NOW), true);
});

test("a fetch already running or paused (offline) → no second one", () => {
  assert.equal(shouldRefetchOnFocus({ dataUpdatedAt: NOW - 60_000, fetchStatus: "fetching" }, NOW), false);
  assert.equal(shouldRefetchOnFocus({ dataUpdatedAt: NOW - 60_000, fetchStatus: "paused" }, NOW), false);
});

test("no data yet (first mount loads it) → no refetch", () => {
  assert.equal(shouldRefetchOnFocus(undefined, NOW), false);
  assert.equal(shouldRefetchOnFocus({ dataUpdatedAt: 0, fetchStatus: "idle" }, NOW), false);
});
