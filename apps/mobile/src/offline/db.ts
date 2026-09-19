/**
 * The on-device SQLite database: `thestoro.db`, opened once, tables created
 * idempotently at first touch. Everything in src/offline/ goes through the
 * `db` (drizzle, sync API) or `sqlite` (raw expo-sqlite) handles exported here.
 *
 * No migration tooling: `CREATE TABLE IF NOT EXISTS` plus a small list of
 * additive `ALTER TABLE … ADD COLUMN` statements that are safe to re-run
 * (SQLite has no IF NOT EXISTS for columns, so each is tried and a
 * "duplicate column" error is swallowed). Nothing here is async so the
 * outbox can be read synchronously by a Zustand selector on first render.
 */
import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";
import { drizzle, type ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import { Platform } from "react-native";

import { setExcludedFromBackup } from "../../modules/backup-exclusion";
import * as schema from "./schema";

export const DB_NAME = "thestoro.db";

/** Bump when the DDL below changes in a way `ensureSchema` must re-run for. */
const SCHEMA_VERSION = 2;

const DDL = [
  `CREATE TABLE IF NOT EXISTS outbox (
    id               TEXT PRIMARY KEY NOT NULL,
    kind             TEXT NOT NULL,
    payload          TEXT NOT NULL,
    idempotency_key  TEXT NOT NULL UNIQUE,
    tenant_id        TEXT,
    user_id          TEXT,
    branch_id        TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  INTEGER NOT NULL DEFAULT 0,
    lease_expires_at INTEGER,
    last_error       TEXT,
    last_error_code  TEXT,
    last_error_text  TEXT,
    actionable       INTEGER NOT NULL DEFAULT 0,
    response         TEXT,
    status           TEXT NOT NULL DEFAULT 'queued'
  )`,
  `CREATE INDEX IF NOT EXISTS outbox_drain_idx ON outbox (status, next_attempt_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS outbox_kind_idx ON outbox (kind, status)`,
  `CREATE TABLE IF NOT EXISTS snapshots (
    key        TEXT PRIMARY KEY NOT NULL,
    json       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  )`,
];

/** Columns added after the first shipped DDL. Each is `ALTER TABLE t ADD COLUMN …`. */
const ADDITIVE_COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  // Owner fence (§6.1) — added after the first DDL shipped without it.
  { table: "outbox", column: "tenant_id", ddl: "tenant_id TEXT" },
  { table: "outbox", column: "user_id", ddl: "user_id TEXT" },
  { table: "outbox", column: "branch_id", ddl: "branch_id TEXT" },
];

/** Indexes over additive columns — must run AFTER the ALTERs on an older install. */
const POST_DDL = [
  `CREATE INDEX IF NOT EXISTS outbox_tenant_idx ON outbox (tenant_id, status)`,
];

let sqliteHandle: SQLiteDatabase | null = null;
let drizzleHandle: ExpoSQLiteDatabase<typeof schema> | null = null;

/**
 * Keep the store out of iCloud / Finder backups (doc 14 C13, security M2):
 * it is a replayable cache of tenant data plus the outbox, not something a
 * restored device should carry across. iOS only — Android is covered app-wide
 * by `allowBackup: false` in app.config.ts. Runs once per process, right
 * after the schema is in place so the -wal / -shm siblings already exist
 * (WAL mode creates them on the first write). Best effort: a missing native
 * module (web, a build made before `npm run ios:prebuild`) or a failed
 * attribute write must never block opening the database.
 */
function excludeFromBackup(handle: SQLiteDatabase) {
  if (Platform.OS !== "ios") return;
  try {
    const base = handle.databasePath;
    if (!base || base === ":memory:") return;
    for (const path of [base, `${base}-wal`, `${base}-shm`]) setExcludedFromBackup(path, true);
  } catch {
    // never block the DB on backup hygiene
  }
}

function ensureSchema(handle: SQLiteDatabase) {
  handle.execSync("PRAGMA journal_mode = WAL");
  handle.execSync("PRAGMA busy_timeout = 3000");
  handle.withTransactionSync(() => {
    for (const stmt of DDL) handle.execSync(stmt);
    for (const c of ADDITIVE_COLUMNS) {
      const cols = handle.getAllSync<{ name: string }>(`PRAGMA table_info(${c.table})`);
      if (cols.some((x) => x.name === c.column)) continue;
      handle.execSync(`ALTER TABLE ${c.table} ADD COLUMN ${c.ddl}`);
    }
    for (const stmt of POST_DDL) handle.execSync(stmt);
    handle.runSync(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(SCHEMA_VERSION),
    );
  });
}

/** Raw expo-sqlite handle. Prefer `db` unless you need PRAGMA / execSync. */
export function getSqlite(): SQLiteDatabase {
  if (!sqliteHandle) {
    sqliteHandle = openDatabaseSync(DB_NAME);
    ensureSchema(sqliteHandle);
    excludeFromBackup(sqliteHandle);
  }
  return sqliteHandle;
}

/** Drizzle handle over the same connection. Sync API: `.all()`, `.get()`, `.run()`. */
export function getDb(): ExpoSQLiteDatabase<typeof schema> {
  if (!drizzleHandle) drizzleHandle = drizzle(getSqlite(), { schema });
  return drizzleHandle;
}

export { schema };
