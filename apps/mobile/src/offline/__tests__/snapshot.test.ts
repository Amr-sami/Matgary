/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/offline/__tests__/snapshot.test.ts
 *
 * snapshot.ts has only type imports, so plain Node loads it. Covers the key
 * allow-list, the per-entry and total size caps with eviction order, the
 * manifest round-trip, and the debounced subscriber against a fake cache.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
// prettier-ignore
import { attachSnapshotSubscriber, dataKey, hashQueryKey, isPersistableEvent, isSnapshotKey, manifestKey, persistResults, planWrites, readManifest, utf8Bytes, type Manifest, type SnapshotIO } from "../snapshot.ts";

// ─── fakes ───────────────────────────────────────────────────────────────────

function fakeIO(branch: string | null = "b1") {
  const store = new Map<string, { data: unknown; updatedAt: number }>();
  let touched = 0;
  let clock = 1_000;
  const io: SnapshotIO = {
    save: (k, d) => void store.set(k, { data: JSON.parse(JSON.stringify(d ?? null)), updatedAt: clock }),
    read: <T,>(k: string) => (store.get(k) as { data: T; updatedAt: number } | undefined) ?? null,
    remove: (k) => void store.delete(k),
    touchLastSynced: () => void touched++,
    scope: () => branch,
    now: () => clock,
  };
  return { io, store, touched: () => touched, tick: (ms: number) => (clock += ms) };
}

// ─── key matching ────────────────────────────────────────────────────────────

test("only allow-listed roots are snapshotted", () => {
  assert.equal(isSnapshotKey(["products"]), true);
  assert.equal(isSnapshotKey(["dashboard", "branch-1"]), true);
  assert.equal(isSnapshotKey(["shop-settings", "b2"]), true);
  assert.equal(isSnapshotKey(["me"]), false); // /me is cached by the session store, not here
  assert.equal(isSnapshotKey(["insights-overview", "7d"]), false);
  assert.equal(isSnapshotKey(["activity", {}]), false);
  assert.equal(isSnapshotKey(["notifications"]), false);
  assert.equal(isSnapshotKey([]), false);
  assert.equal(isSnapshotKey([{ root: "products" }]), false);
  assert.equal(isSnapshotKey(["products"], ["customers"]), false);
});

test("hashQueryKey matches TanStack: object keys sorted, arrays ordered", () => {
  assert.equal(hashQueryKey(["a", { y: 1, x: 2 }]), hashQueryKey(["a", { x: 2, y: 1 }]));
  assert.notEqual(hashQueryKey(["a", "b"]), hashQueryKey(["b", "a"]));
  assert.equal(hashQueryKey(["purchase-orders", { supplierId: "s1" }]), '["purchase-orders",{"supplierId":"s1"}]');
});

test("utf8Bytes counts Arabic as 2 bytes and emoji as 4", () => {
  assert.equal(utf8Bytes("abc"), 3);
  assert.equal(utf8Bytes("متجر"), 8);
  assert.equal(utf8Bytes("😀"), 4);
  assert.equal(utf8Bytes(""), 0);
});

// ─── size caps ───────────────────────────────────────────────────────────────

const caps = { maxEntryBytes: 100, maxTotalBytes: 250 };
const blob = (n: number) => "x".repeat(n);

test("an entry over the per-entry cap is skipped and its old copy evicted", () => {
  const h = hashQueryKey(["products"]);
  const manifest: Manifest = { [h]: { key: ["products"], bytes: 50, updatedAt: 1 } };
  const plan = planWrites(manifest, [{ key: ["products"], data: blob(200), updatedAt: 2 }], caps);
  assert.deepEqual(plan.tooBig, [h]);
  assert.deepEqual(plan.evict, [h]);
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.manifest[h], undefined);
});

test("within caps everything is written and the manifest measures bytes", () => {
  const plan = planWrites({}, [{ key: ["customers"], data: [{ name: "أحمد" }], updatedAt: 5 }], caps);
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.evict.length, 0);
  const h = hashQueryKey(["customers"]);
  assert.equal(plan.manifest[h]?.bytes, utf8Bytes(JSON.stringify([{ name: "أحمد" }])));
  assert.equal(plan.manifest[h]?.updatedAt, 5);
});

test("the total cap evicts the oldest untouched entries first, then the oldest of the batch", () => {
  // Existing: three 80-byte entries (240 total). Incoming: one more 80 → 320 > 250.
  const mk = (root: string, at: number) => ({ [hashQueryKey([root])]: { key: [root], bytes: 80, updatedAt: at } });
  const manifest: Manifest = { ...mk("brands", 30), ...mk("suppliers", 10), ...mk("categories", 20) };
  const plan = planWrites(manifest, [{ key: ["products"], data: blob(78), updatedAt: 40 }], caps);
  // Needs to drop 70 bytes: exactly one untouched entry, the oldest → suppliers.
  assert.deepEqual(plan.evict, [hashQueryKey(["suppliers"])]);
  assert.equal(plan.writes.length, 1);
  assert.equal(Object.keys(plan.manifest).length, 3);

  // A batch alone over the total: oldest of the batch goes.
  const plan2 = planWrites(
    {},
    [
      { key: ["a"], data: blob(78), updatedAt: 1 },
      { key: ["b"], data: blob(78), updatedAt: 3 },
      { key: ["c"], data: blob(78), updatedAt: 2 },
      { key: ["d"], data: blob(78), updatedAt: 4 },
    ],
    caps,
  );
  assert.deepEqual(plan2.evict, [hashQueryKey(["a"])]);
  assert.deepEqual(
    plan2.writes.map((w) => w.key[0]),
    ["b", "c", "d"],
  );
});

test("the last write for the same key in one batch wins", () => {
  const plan = planWrites(
    {},
    [
      { key: ["products"], data: [1], updatedAt: 1 },
      { key: ["products"], data: [1, 2], updatedAt: 2 },
    ],
    caps,
  );
  assert.equal(plan.writes.length, 1);
  assert.deepEqual(plan.writes[0]?.data, [1, 2]);
});

test("unserialisable data is not a snapshot", () => {
  const cyc: Record<string, unknown> = {};
  cyc.self = cyc;
  const plan = planWrites({}, [{ key: ["products"], data: cyc, updatedAt: 1 }], caps);
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.tooBig.length, 0);
});

// ─── manifest round-trip ─────────────────────────────────────────────────────

test("persistResults writes data + manifest under branch-scoped keys and reads back", () => {
  const { io, store } = fakeIO("b1");
  persistResults(io, "b1", [{ key: ["products"], data: [{ id: 1 }], updatedAt: 7 }], caps);
  const h = hashQueryKey(["products"]);
  assert.deepEqual(store.get(dataKey("b1", h))?.data, [{ id: 1 }]);
  assert.ok(store.has(manifestKey("b1")));
  const m = readManifest(io, "b1");
  assert.deepEqual(m[h]?.key, ["products"]);
  assert.equal(readManifest(io, "b2")[h], undefined);

  // Eviction removes the data row too.
  persistResults(io, "b1", [{ key: ["products"], data: blob(500), updatedAt: 8 }], caps);
  assert.equal(store.has(dataKey("b1", h)), false);
  assert.equal(readManifest(io, "b1")[h], undefined);
});

test("readManifest tolerates garbage", () => {
  const { io, store } = fakeIO("b1");
  store.set(manifestKey("b1"), { data: "nope", updatedAt: 1 });
  assert.deepEqual(readManifest(io, "b1"), {});
  store.set(manifestKey("b1"), { data: { bad: { key: "x" }, ok: { key: ["a"], bytes: 1, updatedAt: 1 } }, updatedAt: 1 });
  assert.deepEqual(Object.keys(readManifest(io, "b1")), ["ok"]);
});

// ─── subscriber ──────────────────────────────────────────────────────────────

type Listener = (e: any) => void;
function fakeQueryClient() {
  const listeners = new Set<Listener>();
  const cache = {
    subscribe: (l: Listener) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const client = { getQueryCache: () => cache } as any;
  const emitSuccess = (queryKey: unknown[], data: unknown, extra: { manual?: boolean; status?: string } = {}) => {
    const e = {
      type: "updated",
      action: { type: "success", data, manual: extra.manual },
      query: { queryKey, state: { status: extra.status ?? "success", data, dataUpdatedAt: 123 } },
    };
    listeners.forEach((l) => l(e));
  };
  return { client, emitSuccess, listeners };
}

function fakeTimers() {
  const timers = new Map<number, { fn: () => void; at: number }>();
  let id = 0;
  let now = 0;
  return {
    setTimer: (fn: () => void, ms: number) => {
      timers.set(++id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (t: unknown) => void timers.delete(t as number),
    advance: (ms: number) => {
      now += ms;
      for (const [k, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) {
          timers.delete(k);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

test("isPersistableEvent: real fetch successes only", () => {
  const q = (queryKey: unknown[], data: unknown) => ({ queryKey, state: { status: "success", data } });
  const ev = (over: Record<string, unknown>) => ({ type: "updated", action: { type: "success" }, query: q(["products"], [1]), ...over }) as any;
  assert.equal(isPersistableEvent(ev({})), true);
  assert.equal(isPersistableEvent(ev({ action: { type: "success", manual: true } })), false);
  assert.equal(isPersistableEvent(ev({ action: { type: "error" } })), false);
  assert.equal(isPersistableEvent(ev({ type: "added" })), false);
  assert.equal(isPersistableEvent(ev({ query: q(["insights-overview"], [1]) })), false);
  assert.equal(isPersistableEvent(ev({ query: q(["products"], undefined) })), false);
});

test("subscriber debounces, coalesces per key, and flushes on max wait", () => {
  const { io, store, touched } = fakeIO("b1");
  const { client, emitSuccess } = fakeQueryClient();
  const timers = fakeTimers();
  const sub = attachSnapshotSubscriber(client, io, { caps, debounceMs: 100, maxWaitMs: 300, ...timers });

  emitSuccess(["products"], [1]);
  emitSuccess(["products"], [1, 2]);
  emitSuccess(["insights-overview", "7d"], { ignored: true });
  assert.equal(touched(), 2, "every real read touches lastSynced immediately");
  assert.equal(store.size, 0, "nothing written before the debounce");

  timers.advance(100);
  const h = hashQueryKey(["products"]);
  assert.deepEqual(store.get(dataKey("b1", h))?.data, [1, 2]);
  assert.equal(store.has(dataKey("b1", hashQueryKey(["insights-overview", "7d"]))), false);

  // A burst that never quiets still lands at maxWait.
  store.clear();
  for (let i = 0; i < 3; i++) {
    emitSuccess(["customers"], [i]);
    timers.advance(90);
  }
  assert.equal(store.size, 0, "debounce kept resetting");
  timers.advance(30); // 300ms since the burst began → maxWait fires
  assert.deepEqual(store.get(dataKey("b1", hashQueryKey(["customers"])))?.data, [2]);

  // Manual successes (setQueryData / hydration) are never re-persisted.
  store.clear();
  emitSuccess(["products"], [9], { manual: true });
  timers.advance(1000);
  assert.equal(store.size, 0);

  // detach flushes what is pending.
  emitSuccess(["brands"], ["b"]);
  sub.detach();
  assert.deepEqual(store.get(dataKey("b1", hashQueryKey(["brands"])))?.data, ["b"]);
  emitSuccess(["categories"], ["c"]);
  timers.advance(1000);
  assert.equal(store.has(dataKey("b1", hashQueryKey(["categories"]))), false, "detached");
});

test("subscriber writes nothing when signed out, and persist() honours the allow-list", () => {
  const { io, store } = fakeIO(null);
  const { client, emitSuccess } = fakeQueryClient();
  const timers = fakeTimers();
  const sub = attachSnapshotSubscriber(client, io, { caps, ...timers });
  emitSuccess(["products"], [1]);
  sub.persist(["shop-settings"], { user: 1 });
  timers.advance(10_000);
  assert.equal(store.size, 0);
  sub.detach();

  const signedIn = fakeIO("b7");
  const sub2 = attachSnapshotSubscriber(client, signedIn.io, { caps, ...timers });
  sub2.persist(["shop-settings"], { user: 1 });
  sub2.persist(["insights-deep"], { nope: 1 });
  sub2.flush();
  assert.deepEqual(signedIn.store.get(dataKey("b7", hashQueryKey(["shop-settings"])))?.data, { user: 1 });
  assert.equal(signedIn.store.size, 2, "data + manifest only");
  sub2.detach();
});

test("a response is filed under the branch its fetch STARTED on, not the one current when it lands", () => {
  let branch: string | null = "A";
  const { io, store } = fakeIO("A");
  io.scope = () => branch;
  const { client, listeners } = fakeQueryClient();
  const timers = fakeTimers();
  const sub = attachSnapshotSubscriber(client, io, { caps, ...timers });
  const query = { queryKey: ["products"], queryHash: hashQueryKey(["products"]), state: { status: "success", data: ["a-products"], dataUpdatedAt: 5 } };
  listeners.forEach((l) => l({ type: "updated", action: { type: "fetch" }, query }));
  branch = "B"; // the cashier switched while the request was in flight
  listeners.forEach((l) => l({ type: "updated", action: { type: "success", data: ["a-products"] }, query }));
  sub.flush();
  assert.deepEqual(store.get(dataKey("A", query.queryHash))?.data, ["a-products"]);
  assert.equal(store.has(dataKey("B", query.queryHash)), false, "never under B");
  sub.detach();
});

test("an over-cap entry is reported through onDropped, and products get the larger cap", () => {
  const { io } = fakeIO("b1");
  const dropped: Array<{ key: unknown; bytes: number }> = [];
  io.onDropped = (d) => dropped.push(...d);
  const tight = { maxEntryBytes: 100, maxTotalBytes: 10_000, maxEntryBytesByRoot: { products: 1_000 } };
  const plan = persistResults(io, "b1", [
    { key: ["products"], data: blob(500), updatedAt: 1 },
    { key: ["customers"], data: blob(500), updatedAt: 1 },
  ], tight);
  assert.equal(plan.writes.length, 1);
  assert.deepEqual(plan.writes[0]?.key, ["products"]);
  assert.equal(dropped.length, 1);
  assert.deepEqual(dropped[0]?.key, ["customers"]);
});
