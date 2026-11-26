/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/offline/__tests__/backup-exclusion.test.ts
 *
 * Two things are pinned here:
 *  1. modules/backup-exclusion/index.ts — the JS face of the local Expo module —
 *     returns false and never throws where the native module is absent (plain
 *     Node here, web in the app, a simulator build made before ios:prebuild).
 *  2. db.ts flags the database file and its -wal / -shm siblings exactly once
 *     per process, on iOS only, and a wrapper that throws never blocks the DB.
 *
 * db.ts imports expo-sqlite, drizzle's expo driver and react-native, none of
 * which load in plain Node, so the second half registers synchronous module
 * hooks (node:module `registerHooks`, Node ≥ 22.15) that swap those four
 * specifiers for in-memory fakes before db.ts is imported. No flags beyond
 * what `npm test` already passes; the fakes are scoped to this process.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import { isBackupExclusionAvailable, setExcludedFromBackup } from "../../../modules/backup-exclusion/index.ts";

// ─── 1. wrapper fallback ─────────────────────────────────────────────────────

test("wrapper reports the native module as unavailable in plain Node", () => {
  assert.equal(isBackupExclusionAvailable(), false);
});

test("setExcludedFromBackup returns false (and does not throw) without the native module", () => {
  assert.equal(setExcludedFromBackup("/data/Documents/SQLite/thestoro.db", true), false);
  assert.equal(setExcludedFromBackup("file:///data/Documents/SQLite/thestoro.db-wal", false), false);
});

// ─── 2. db.ts wiring ─────────────────────────────────────────────────────────

type Harness = {
  os: string;
  throwOnCall: boolean;
  calls: [string, boolean][];
  opened: string[];
};
declare global {
  var __backupExclusionTest: Harness;
}

const FAKE_DB_DIR = "/data/Containers/Documents/SQLite";

/** Virtual ESM sources served for the specifiers db.ts imports. */
const FAKES: Record<string, string> = {
  "fake:react-native": `
    export const Platform = { get OS() { return globalThis.__backupExclusionTest.os; } };
  `,
  "fake:expo-sqlite": `
    export function openDatabaseSync(name) {
      globalThis.__backupExclusionTest.opened.push(name);
      return {
        databasePath: ${JSON.stringify(FAKE_DB_DIR)} + "/" + name,
        execSync() {},
        runSync() {},
        getAllSync() { return []; },
        withTransactionSync(fn) { fn(); },
      };
    }
  `,
  "fake:drizzle-orm/expo-sqlite": `
    export function drizzle(client, options) { return { client, options }; }
  `,
  "fake:backup-exclusion": `
    export function setExcludedFromBackup(path, excluded) {
      const h = globalThis.__backupExclusionTest;
      h.calls.push([path, excluded]);
      if (h.throwOnCall) throw new Error("native blew up");
      return true;
    }
  `,
};

function fakeFor(specifier: string): string | null {
  if (specifier === "react-native") return "fake:react-native";
  if (specifier === "expo-sqlite") return "fake:expo-sqlite";
  if (specifier === "drizzle-orm/expo-sqlite") return "fake:drizzle-orm/expo-sqlite";
  if (/(^|\/)modules\/backup-exclusion(\/index(\.ts)?)?$/.test(specifier)) return "fake:backup-exclusion";
  return null;
}

// @types/node 20 predates registerHooks; the runtime (Node 24) has it.
const { registerHooks } = nodeModule as unknown as {
  registerHooks: (hooks: {
    resolve?: (specifier: string, context: unknown, next: (s: string, c: unknown) => unknown) => unknown;
    load?: (url: string, context: unknown, next: (u: string, c: unknown) => unknown) => unknown;
  }) => void;
};

registerHooks({
  resolve(specifier, context, next) {
    const fake = fakeFor(specifier);
    if (fake) return { url: fake, shortCircuit: true };
    try {
      return next(specifier, context);
    } catch (err) {
      // Metro resolves extensionless relative imports (db.ts → "./schema");
      // Node's ESM loader does not, so retry with .ts once.
      const notFound = (err as { code?: string }).code === "ERR_MODULE_NOT_FOUND";
      if (!notFound || !specifier.startsWith(".") || /\.[cm]?[jt]sx?$/.test(specifier)) throw err;
      return next(`${specifier}.ts`, context);
    }
  },
  load(url, context, next) {
    const source = FAKES[url];
    return source ? { format: "module", source, shortCircuit: true } : next(url, context);
  },
});

type DbModule = { DB_NAME: string; getSqlite: () => unknown; getDb: () => unknown };

/** Fresh db.ts instance per scenario (module-scoped singletons inside). */
async function loadDb(scenario: string, over: Partial<Harness> = {}): Promise<DbModule> {
  globalThis.__backupExclusionTest = { os: "ios", throwOnCall: false, calls: [], opened: [], ...over };
  return (await import(`../db.ts?scenario=${scenario}`)) as DbModule;
}

test("iOS: db.ts excludes the db, -wal and -shm once per process, after the first open", async () => {
  const db = await loadDb("ios");
  const h = globalThis.__backupExclusionTest;
  assert.deepEqual(h.calls, [], "nothing runs at import time");

  const first = db.getSqlite();
  const base = `${FAKE_DB_DIR}/${db.DB_NAME}`;
  assert.deepEqual(h.calls, [
    [base, true],
    [`${base}-wal`, true],
    [`${base}-shm`, true],
  ]);

  // Later touches — raw handle or drizzle — reuse the open handle and do not
  // flag the files again.
  assert.equal(db.getSqlite(), first);
  db.getDb();
  db.getDb();
  assert.equal(h.opened.length, 1);
  assert.equal(h.calls.length, 3);
});

test("android: no exclusion call (allowBackup=false covers the app)", async () => {
  const db = await loadDb("android", { os: "android" });
  db.getSqlite();
  db.getDb();
  assert.deepEqual(globalThis.__backupExclusionTest.calls, []);
  assert.equal(globalThis.__backupExclusionTest.opened.length, 1);
});

test("a throwing wrapper never blocks opening the database", async () => {
  const db = await loadDb("throws", { throwOnCall: true });
  assert.doesNotThrow(() => db.getSqlite());
  assert.ok(db.getDb());
  assert.equal(globalThis.__backupExclusionTest.calls.length, 1, "bails at the first failure");
  assert.equal(globalThis.__backupExclusionTest.opened.length, 1);
});
