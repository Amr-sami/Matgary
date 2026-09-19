/**
 * Read-side cache: the last good server answer for a key, so a screen has
 * something to render with no signal. Staleness is the READER's business —
 * `updatedAt` is returned so the UI can show "as of 3h ago", never hidden.
 *
 * Every key is prefixed with the signed-in tenant id HERE, so a caller
 * cannot forget it: on a shared tablet the next account can never read the
 * previous shop's products/customers (§5.5). Signed out → reads miss, writes
 * are dropped. The outbox engine also wipes the table on every sign-out.
 */
import { eq } from "drizzle-orm";

import { useSession } from "@/stores/session";

import { getDb } from "./db";
import { snapshots } from "./schema";

export interface Snapshot<T> {
  data: T;
  updatedAt: number;
}

/** `<tenant>:<key>`, or null when nobody is signed in. */
function scoped(key: string): string | null {
  const tenant = useSession.getState().me?.tenant.id;
  return tenant ? `${tenant}:${key}` : null;
}

export function saveSnapshot(key: string, data: unknown) {
  saveSnapshotJson(key, JSON.stringify(data ?? null));
}

/** Same as `saveSnapshot` for a value the caller has already serialised (the read path measures its JSON first). */
export function saveSnapshotJson(key: string, json: string) {
  const k = scoped(key);
  if (!k) return;
  const now = Date.now();
  getDb()
    .insert(snapshots)
    .values({ key: k, json, updatedAt: now })
    .onConflictDoUpdate({ target: snapshots.key, set: { json, updatedAt: now } })
    .run();
}

export function readSnapshot<T>(key: string): Snapshot<T> | null {
  const k = scoped(key);
  if (!k) return null;
  const row = getDb().select().from(snapshots).where(eq(snapshots.key, k)).get();
  if (!row) return null;
  try {
    return { data: JSON.parse(row.json) as T, updatedAt: row.updatedAt };
  } catch {
    return null;
  }
}

export function deleteSnapshot(key: string) {
  const k = scoped(key);
  if (!k) return;
  getDb().delete(snapshots).where(eq(snapshots.key, k)).run();
}

/**
 * Wipe every snapshot, all tenants. The outbox engine calls this on every
 * signedIn → signedOut edge (explicit sign-out and the client's dead-session
 * path alike), so a shared tablet never leaks a shop's data (§5.5).
 */
export function clearSnapshots() {
  getDb().delete(snapshots).run();
}
