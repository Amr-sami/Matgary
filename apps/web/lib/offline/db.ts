"use client";

import Dexie, { type Table } from "dexie";

// Single IndexedDB database holding everything the POS needs to keep
// working without internet.
//
// Two tables:
//   1. `outbox` — mutations queued while offline (sales, returns, etc.)
//      that the sync engine flushes to the server when connectivity
//      returns. Indexed on `status` so the drainer can pick `pending`
//      rows in order.
//   2. `snapshot` — read-side cache of products + categories for the
//      active branch, refreshed from /api/pos/bootstrap on every online
//      page open. Single row keyed by `branchId` so switching branches
//      shows the right catalog without crossing them.
//
// Versioning: bump in monotonically. Dexie applies upgrades automatically
// without dropping data unless we explicitly tell it to. Keep changes
// additive — schema removals require an explicit upgrade fn.

export type OutboxStatus = "pending" | "syncing" | "synced" | "failed";

export interface OutboxRow {
  id?: number;
  /** Type of mutation. Today: only "sale". Reserved for "return" /
   *  "stock_adjust" etc. when those go offline-capable. */
  type: "sale";
  /** UUID generated client-side. Server uses it to dedupe replays so a
   *  flaky sync that retries the same row never creates two charges. */
  idempotencyKey: string;
  /** Tenant + branch the row belongs to. Stored so a multi-store cashier
   *  who switches branches mid-sync doesn't replay the wrong rows. */
  tenantId: string;
  branchId: string;
  /** The exact JSON body the cart endpoint expects. */
  payload: unknown;
  status: OutboxStatus;
  /** Wall-clock time the cashier rang up the sale (browser time). */
  createdAt: number;
  /** Best-effort sync attempt count for backoff + UI. */
  attempts: number;
  /** Last error message — surfaces on the offline-indicator tooltip. */
  lastError?: string;
  /** Server response body when status === "synced" (kept briefly so the UI
   *  can confirm what landed before the row is purged). */
  syncedResponse?: unknown;
  /** Wall-clock time of the last status change. */
  updatedAt: number;
}

export interface SnapshotRow {
  /** Composite key: `${tenantId}:${branchId}`. One snapshot per branch. */
  key: string;
  tenantId: string;
  branchId: string;
  /** Wall-clock time the snapshot was fetched. */
  fetchedAt: number;
  /** Whatever shape `/api/pos/bootstrap` returns — kept untyped here so
   *  the schema doesn't need to bump on every payload tweak. */
  payload: unknown;
}

class MatgaryOfflineDb extends Dexie {
  outbox!: Table<OutboxRow, number>;
  snapshot!: Table<SnapshotRow, string>;

  constructor() {
    super("matgary_offline");
    this.version(1).stores({
      // Indexes: id (auto-pk), status (drainer query), createdAt (FIFO).
      outbox: "++id, status, createdAt, [tenantId+branchId]",
      // Primary key on `key`; secondary on (tenantId, branchId) for cleanup.
      snapshot: "&key, [tenantId+branchId]",
    });
  }
}

// Lazy singleton — Dexie touches `window` so we can't instantiate at
// module load on the server side. Components import via getOfflineDb().
let _db: MatgaryOfflineDb | null = null;
export function getOfflineDb(): MatgaryOfflineDb {
  if (typeof window === "undefined") {
    throw new Error("getOfflineDb() must be called from the browser");
  }
  if (!_db) _db = new MatgaryOfflineDb();
  return _db;
}
