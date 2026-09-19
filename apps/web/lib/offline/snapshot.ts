"use client";

import { getOfflineDb } from "./db";

// Read-side snapshot management. The cashier needs to see the catalog
// even when wifi blinks, so every successful online page load writes a
// fresh copy of `/api/pos/bootstrap` to IndexedDB. The cart UI reads
// from this cache when offline, and from the network with cache-fallback
// otherwise.
//
// Cache key: (tenantId, branchId). Switching branches reads a different
// snapshot — the catalogs are isolated, multi-store style.

export interface SnapshotProduct {
  id: string;
  name: string;
  brand: string | null;
  price: number;
  quantity: number;
  sku: string | null;
  categoryId: string;
  attributes: Record<string, string>;
}

export interface SnapshotCategory {
  id: string;
  key: string;
  label: string;
  icon: string | null;
}

export interface PosSnapshot {
  branch: { id: string; name: string };
  fetchedAt: number;
  products: SnapshotProduct[];
  categories: SnapshotCategory[];
}

const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000; // 24h — useful even after a long offline shift

function snapshotKey(tenantId: string, branchId: string): string {
  return `${tenantId}:${branchId}`;
}

/**
 * Pull the snapshot from the server and write it to IndexedDB. Throws on
 * network/HTTP failure so the caller knows to fall back to whatever's
 * already cached.
 */
export async function refreshSnapshot(
  tenantId: string,
  branchId: string,
): Promise<PosSnapshot> {
  const res = await fetch("/api/pos/bootstrap", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`bootstrap failed (${res.status})`);
  }
  const payload = (await res.json()) as PosSnapshot;
  const db = getOfflineDb();
  await db.snapshot.put({
    key: snapshotKey(tenantId, branchId),
    tenantId,
    branchId,
    fetchedAt: Date.now(),
    payload,
  });
  return payload;
}

/** Read whatever's cached for (tenant, branch). Null if nothing yet. */
export async function readSnapshot(
  tenantId: string,
  branchId: string,
): Promise<PosSnapshot | null> {
  const db = getOfflineDb();
  const row = await db.snapshot.get(snapshotKey(tenantId, branchId));
  return row ? (row.payload as PosSnapshot) : null;
}

/**
 * Locally decrement a snapshot product's quantity. Used the moment the
 * cashier rings up an offline sale so the stock display + the next
 * cart line reflect the cart-induced shortage before the server learns.
 *
 * Best-effort: if the snapshot is missing the product (catalog edited
 * since last bootstrap) we just no-op — the server is the source of
 * truth and will reject the sync if the product genuinely doesn't exist.
 */
export async function decrementSnapshotStock(
  tenantId: string,
  branchId: string,
  productId: string,
  delta: number,
): Promise<void> {
  const db = getOfflineDb();
  const key = snapshotKey(tenantId, branchId);
  const row = await db.snapshot.get(key);
  if (!row) return;
  const payload = row.payload as PosSnapshot;
  const product = payload.products.find((p) => p.id === productId);
  if (!product) return;
  product.quantity = Math.max(0, product.quantity - delta);
  await db.snapshot.put({ ...row, payload });
}

/** Snapshot is "stale" after 24h — caller can decide whether to refuse
 *  offline operation or proceed with a warning. */
export function isStale(snapshot: PosSnapshot): boolean {
  return Date.now() - snapshot.fetchedAt > SNAPSHOT_TTL_MS;
}
