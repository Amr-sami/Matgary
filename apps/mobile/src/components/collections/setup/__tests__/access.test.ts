/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/components/collections/setup/__tests__/access.test.ts
 *
 * `access.ts` has type-only imports. Cases: doc 15 spec 09 §4.2 and §6
 * criteria 1, 7 and 9 (tile, hub gate, the staff branch picker, the L2 gate).
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import * as a from "../access.ts";

const ON = { collections: true, collectionsIngest: false, collectionsAutoConfirm: false, collectionsProviders: false, collectionsAvailable: true };
const branches = [
  { id: "b1", name: "Main", isPrimary: true },
  { id: "b2", name: "Mall", isPrimary: false },
];
const owner = { isOwner: true, permissions: [], features: ON, branch: { id: "b1", name: "Main", isPrimary: true }, branches };
const manager = { isOwner: false, permissions: ["record_sales", "manage_collection_accounts"], features: ON, branch: { id: "b2", name: "Mall", isPrimary: false }, branches };
const cashier = { isOwner: false, permissions: ["record_sales", "view_collections", "confirm_collections"], features: ON, branch: { id: "b1", name: "Main", isPrimary: true }, branches };

test("criterion 1: the tile shows for the owner and a manager, never for a cashier", () => {
  assert.equal(a.collectionsTileVisible(a.collectionsSetupAccess(owner)), true);
  assert.equal(a.collectionsTileVisible(a.collectionsSetupAccess(manager)), true);
  assert.equal(a.collectionsTileVisible(a.collectionsSetupAccess(cashier)), false);
});

test("criterion 1: COLLECTIONS_ENABLED=off (collectionsAvailable false) hides it for everyone; a missing features object too", () => {
  const off = { ...ON, collections: false, collectionsAvailable: false };
  assert.equal(a.collectionsTileVisible(a.collectionsSetupAccess({ ...owner, features: off })), false);
  assert.equal(a.collectionsTileVisible(a.collectionsSetupAccess({ ...owner, features: undefined })), false);
  assert.equal(a.collectionsScreenGate(a.collectionsSetupAccess({ ...owner, features: off })), "unavailable");
  assert.equal(a.collectionsTileVisible(a.collectionsSetupAccess(null)), false);
});

test("the branch switch being off does NOT hide the hub (the owner turns it on there)", () => {
  const branchOff = { ...ON, collections: false };
  const acc = a.collectionsSetupAccess({ ...owner, features: branchOff });
  assert.equal(acc.collections, false);
  assert.equal(a.collectionsTileVisible(acc), true);
  assert.equal(a.collectionsScreenGate(acc), "ok");
});

test("hub gate: no permission wins over unavailable", () => {
  assert.equal(a.collectionsScreenGate(a.collectionsSetupAccess(cashier)), "noPermission");
  assert.equal(a.collectionsScreenGate(a.collectionsSetupAccess({ ...cashier, features: undefined })), "noPermission");
  assert.equal(a.collectionsScreenGate(a.collectionsSetupAccess(owner)), "ok");
});

test("criterion 9: the L2 flags follow features.collectionsIngest / collectionsAutoConfirm only", () => {
  assert.equal(a.collectionsSetupAccess(owner).ingest, false);
  const l2 = a.collectionsSetupAccess({ ...owner, features: { ...ON, collectionsIngest: true, collectionsAutoConfirm: true } });
  assert.equal(l2.ingest, true);
  assert.equal(l2.autoConfirm, true);
});

test("criterion 7: the owner's branch picker offers All branches + each branch; a manager only their own", () => {
  assert.deepEqual(a.branchChoices(owner, "All"), [
    { id: null, name: "All" },
    { id: "b1", name: "Main" },
    { id: "b2", name: "Mall" },
  ]);
  assert.deepEqual(a.branchChoices(manager, "All"), [{ id: "b2", name: "Mall" }]);
  assert.deepEqual(a.branchChoices(null, "All"), []);
});
