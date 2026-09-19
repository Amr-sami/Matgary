/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import { applyDeltas, pendingDeltas } from "../local-delta.ts";

const row = (
  status: string,
  lines: { productId: string; quantity: number }[],
  catalogUpdatedAt?: Record<string, string>,
  kind = "sale",
) => ({
  kind,
  status,
  payload: { lines, options: {}, ...(catalogUpdatedAt ? { catalogUpdatedAt } : {}) },
});

test("pendingDeltas sums queued/sending/failed sale rows and ignores done + other kinds", () => {
  const d = pendingDeltas([
    row("queued", [{ productId: "a", quantity: 2 }]),
    row("sending", [{ productId: "a", quantity: 1 }, { productId: "b", quantity: 5 }], { a: "T1" }),
    row("failed", [{ productId: "c", quantity: 1 }]),
    row("done", [{ productId: "a", quantity: 100 }]),
    row("queued", [{ productId: "a", quantity: 100 }], undefined, "return"),
  ]);
  assert.deepEqual(d.get("a"), { qty: 3, byStamp: new Map([[null, 2], ["T1", 1]]) });
  assert.deepEqual(d.get("b"), { qty: 5, byStamp: new Map([[null, 5]]) });
  assert.deepEqual(d.get("c"), { qty: 1, byStamp: new Map([[null, 1]]) });
  assert.equal(d.size, 3);
});

test("pendingDeltas tolerates junk payloads", () => {
  assert.equal(pendingDeltas([row("queued", []), { kind: "sale", status: "queued", payload: null }]).size, 0);
  assert.deepEqual(
    pendingDeltas([{ kind: "sale", status: "queued", payload: { lines: [{ productId: "a", quantity: 1 }], catalogUpdatedAt: ["junk"] } }]).get("a"),
    { qty: 1, byStamp: new Map([[null, 1]]) },
  );
});

test("applyDeltas decrements, floors at 0, copies only touched rows, and returns the same array when nothing changes", () => {
  const products = [
    { id: "a", quantity: 5 },
    { id: "b", quantity: 2 },
    { id: "z", quantity: 9 },
  ];
  const out = applyDeltas(products, pendingDeltas([row("queued", [{ productId: "a", quantity: 3 }, { productId: "b", quantity: 7 }])]));
  assert.notEqual(out, products);
  assert.deepEqual(out.map((p) => p.quantity), [2, 0, 9]);
  assert.equal(out[2], products[2]);
  assert.equal(applyDeltas(products, new Map()), products);
  assert.equal(applyDeltas(products, pendingDeltas([row("queued", [{ productId: "nope", quantity: 1 }])])), products);
});

test("applyDeltas subtracts a ring only while the server still reports the stamp it was rung against (server wins)", () => {
  const products = [
    { id: "a", quantity: 5, updatedAt: "2026-09-18T11:00:00Z" }, // moved since the ring → left alone
    { id: "b", quantity: 5, updatedAt: "2026-09-18T09:00:00Z" }, // same stamp → ours
    { id: "c", quantity: 5, updatedAt: null }, // server sends no stamp → ours
    { id: "d", quantity: 5, updatedAt: "2026-09-18T09:00:00.000Z" }, // same instant, other formatting → ours
    { id: "e", quantity: 5, updatedAt: "2026-09-18T11:00:00Z" }, // ring captured nothing → ours
  ];
  const stamps = { a: "2026-09-18T10:00:00Z", b: "2026-09-18T09:00:00Z", c: "2026-09-18T09:00:00Z", d: "2026-09-18T09:00:00Z" };
  const out = applyDeltas(
    products,
    pendingDeltas([
      row("queued", [{ productId: "a", quantity: 1 }, { productId: "b", quantity: 1 }, { productId: "c", quantity: 1 }, { productId: "d", quantity: 1 }], stamps),
      row("queued", [{ productId: "e", quantity: 1 }]),
    ]),
  );
  assert.deepEqual(out.map((p) => p.quantity), [5, 4, 4, 4, 4]);
});

test("applyDeltas judges each ring by its own stamp: a restock between two offline rings drops only the older one", () => {
  const products = [{ id: "a", quantity: 20, updatedAt: "T2" }];
  const out = applyDeltas(
    products,
    pendingDeltas([row("queued", [{ productId: "a", quantity: 2 }], { a: "T1" }), row("queued", [{ productId: "a", quantity: 3 }], { a: "T2" })]),
  );
  assert.deepEqual(out.map((p) => p.quantity), [17]);
  // Device clock never enters: no createdAt is read at all.
  assert.equal(applyDeltas(products, pendingDeltas([row("queued", [{ productId: "a", quantity: 2 }], { a: "T1" })])), products);
});
