/**
 * Mobile chat state regression tests — duplicate message guard + ID
 * collision resistance.
 *
 * Run:  node --test --experimental-strip-types apps/mobile/src/lib/__tests__/chatState.test.ts
 *
 * This is the client half of the duplicate-assistant-message fix. React-Query
 * mutations default to retry: 3, which means a transient 500 followed by a
 * success fires onSuccess twice. Without ID-based dedup, that produced two
 * identical assistant messages. The retry has been disabled, but
 * appendUnique is the belt-and-braces guard.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";

// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import { appendManyUnique, appendUnique, makeMessageId } from "../chatState.ts";

/* ─────────────────────────── appendUnique ─────────────────────────────── */

test("appendUnique appends a new message with a fresh id", () => {
  const out = appendUnique([{ id: "a" }, { id: "b" }], { id: "c" });
  assert.deepEqual(out.map((m) => m.id), ["a", "b", "c"]);
});

test("appendUnique drops a duplicate id (no append)", () => {
  const prev = [{ id: "a" }, { id: "b" }];
  const out = appendUnique(prev, { id: "a" });
  assert.equal(out.length, 2);
  // Identity preserved — no new array if nothing changed.
  assert.strictEqual(out, prev);
});

test("appendUnique preserves first-wins semantics", () => {
  const prev: Array<{ id: string; payload: string }> = [{ id: "a", payload: "first" }];
  const out = appendUnique(prev, { id: "a", payload: "second" });
  assert.equal(out[0]!.payload, "first");
});

test("appendUnique regression — retry double-fire cannot duplicate", () => {
  // Simulate the retry scenario: onSuccess fires twice with the same msg id.
  let state: { id: string }[] = [];
  const msg = { id: "retry-double" };
  state = appendUnique(state, msg);
  state = appendUnique(state, msg); // the retry
  assert.equal(state.length, 1);
});

/* ─────────────────────────── appendManyUnique ─────────────────────────── */

test("appendManyUnique concatenates new messages", () => {
  const out = appendManyUnique([{ id: "a" }], [{ id: "b" }, { id: "c" }]);
  assert.deepEqual(out.map((m) => m.id), ["a", "b", "c"]);
});

test("appendManyUnique drops duplicates inside the incoming batch", () => {
  const out = appendManyUnique([{ id: "a" }], [{ id: "b" }, { id: "b" }, { id: "c" }]);
  assert.deepEqual(out.map((m) => m.id), ["a", "b", "c"]);
});

test("appendManyUnique drops incoming ids already present", () => {
  const out = appendManyUnique([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]);
  assert.deepEqual(out.map((m) => m.id), ["a", "b", "c"]);
});

/* ─────────────────────────── makeMessageId ────────────────────────────── */

test("makeMessageId returns a RFC-4122 v4 uuid", () => {
  const id = makeMessageId();
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test("makeMessageId collision-resistance over 10k calls", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 10_000; i++) {
    const id = makeMessageId();
    assert.ok(!seen.has(id), `id collision at iteration ${i}: ${id}`);
    seen.add(id);
  }
});

test("regression — old makeId(${Date.now()}_${rand6}) would collide under fast calls", () => {
  // Reproduces what the old generator could produce in the same ms. We use
  // the new generator here and show it doesn't collide. The test's purpose
  // is a frozen-in-time anchor: any future replacement must pass this too.
  const batch: string[] = [];
  for (let i = 0; i < 1000; i++) batch.push(makeMessageId());
  assert.equal(new Set(batch).size, batch.length);
});
