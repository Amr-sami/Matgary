/**
 * The RN-bound half of the read path: binds `snapshot.ts` (pure) to the
 * offline engine and the session, hydrates the QueryClient at startup, and
 * exposes `useSnapshotAge()` for the chip.
 *
 *   hydrateFromSnapshots(queryClient)  — once after signedIn: every stored
 *     key for the current branch is put back with its ORIGINAL updatedAt, so
 *     the query is already stale (staleTime 30s) and refetches the moment a
 *     screen mounts online, while painting the last good answer offline.
 *     Keys that already hold data (a fetch beat us) are left alone — which
 *     is only safe because <SnapshotRefresher/> clears the QueryClient on
 *     every sign-out, so "already has data" always means THIS session's.
 *     Reads and JSON.parse are synchronous on the JS thread, so the caller
 *     hydrates `HYDRATE_FIRST` (what the POS needs to sell) before the first
 *     frame and the rest after interactions.
 *
 *   useSnapshotAge()  — seconds since the engine's lastSyncedAt (which
 *     `touchLastSynced()` persists across launches), ticking every 15s;
 *     null until the device has ever synced.
 */
import { useEffect, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";

import { deleteSnapshot, readSnapshot, saveSnapshot, touchLastSynced, useOffline } from "@/offline";
import { addBreadcrumb } from "@/observability/sentry";
import { useSession } from "@/stores/session";

import { getDb } from "./db";
import {
  SNAPSHOT_GC_TIME_MS,
  SNAPSHOT_ROOTS,
  dataKey,
  isSnapshotKey,
  readManifest,
  type Manifest,
  type SnapshotIO,
} from "./snapshot";
import { saveSnapshotJson } from "./snapshots";

/** The roots the POS needs to sell; hydrated synchronously, before the first signed-in frame. */
export const HYDRATE_FIRST: readonly string[] = ["products", "categories", "customers", "shop-settings"];

/** The engine, seen through the interface `snapshot.ts` wants. */
export const snapshotIO: SnapshotIO = {
  save: saveSnapshot,
  saveJson: saveSnapshotJson,
  read: readSnapshot,
  remove: deleteSnapshot,
  transact: (fn) => getDb().transaction(() => fn()),
  touchLastSynced: () => touchLastSynced(),
  scope: () => useSession.getState().me?.branch.id ?? null,
  // An answer over its cap is never kept: without this the shop would look
  // like it had "never synced" offline and nobody would know why.
  onDropped: (dropped) => {
    const keys = dropped.map((d) => `${JSON.stringify(d.key)}=${d.bytes}B`);
    addBreadcrumb("snapshot", "entry over size cap, not snapshotted", { keys });
    if (__DEV__) console.warn("[snapshot] over size cap, not kept:", keys.join(", "));
  },
};

export interface HydrateResult {
  /** Keys put into the cache. */
  hydrated: number;
  /** Keys skipped because the cache already had data. */
  skipped: number;
  /** Epoch ms of the freshest snapshot restored, or null when none. */
  newestUpdatedAt: number | null;
}

/**
 * Keep hydrated roots in memory for the day: a query created by
 * `setQueryData` has no observer, and the default 5-minute GC would drop the
 * catalogue before the cashier ever opens the POS.
 */
function protectFromGc(queryClient: QueryClient) {
  for (const root of SNAPSHOT_ROOTS) {
    const existing = queryClient.getQueryDefaults([root]);
    if (existing.gcTime === undefined) queryClient.setQueryDefaults([root], { ...existing, gcTime: SNAPSHOT_GC_TIME_MS });
  }
}

export interface HydrateOptions {
  /** Restore only keys whose root is in this list … */
  only?: readonly string[];
  /** … or every key except these roots. */
  except?: readonly string[];
}

export function hydrateFromSnapshots(queryClient: QueryClient, io: SnapshotIO = snapshotIO, opts: HydrateOptions = {}): HydrateResult {
  const result: HydrateResult = { hydrated: 0, skipped: 0, newestUpdatedAt: null };
  const branch = io.scope();
  if (!branch) return result;

  protectFromGc(queryClient);

  let manifest: Manifest;
  try {
    manifest = readManifest(io, branch);
  } catch {
    return result; // a broken index is the same as no index
  }

  for (const [hash, entry] of Object.entries(manifest)) {
    if (opts.only && !isSnapshotKey(entry.key, opts.only)) continue;
    if (opts.except && isSnapshotKey(entry.key, opts.except)) continue;
    let snap: { data: unknown; updatedAt: number } | null = null;
    try {
      snap = io.read<unknown>(dataKey(branch, hash));
    } catch {
      snap = null;
    }
    if (!snap) continue;
    const state = queryClient.getQueryState(entry.key);
    if (state && state.data !== undefined) {
      result.skipped++;
      continue;
    }
    queryClient.setQueryData(entry.key, snap.data, { updatedAt: snap.updatedAt });
    result.hydrated++;
    if (result.newestUpdatedAt === null || snap.updatedAt > result.newestUpdatedAt) result.newestUpdatedAt = snap.updatedAt;
  }
  return result;
}

/** Seconds since the last successful sync (read or write), or null if never. Re-renders every 15s. */
export function useSnapshotAge(): number | null {
  const lastSyncedAt = useOffline((s) => s.lastSyncedAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (lastSyncedAt === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [lastSyncedAt]);

  if (lastSyncedAt === null) return null;
  return Math.max(0, Math.floor((now - lastSyncedAt) / 1000));
}
