/**
 * localDelta — the TanStack Query binding of ./local-delta.ts (doc 06 §6.5).
 *
 * Mounted once by <OfflineDrainer/> via `attachLocalDelta(queryClient)`:
 *
 *  1. Every time the ["products"] query receives a NEW answer — a server
 *     fetch, or hydrate.ts putting the snapshot back — that answer is kept
 *     as the BASE (server truth) and the cache is overwritten with
 *     `applyDeltas(base, pendingDeltas(outbox))`. The write is a manual
 *     setQueryData, which snapshot.ts deliberately does not persist, so the
 *     snapshot on disk stays the server's number and the delta is re-derived
 *     from the outbox at the next launch.
 *  2. Every outbox change (`useOffline.revision`) re-applies the deltas to
 *     the base, so a second offline sale decrements again, and a row that
 *     is discarded / edited puts the units back.
 *  3. When a pending sale row becomes `done` — the server booked it — the
 *     ["products"] query is invalidated: online, the next paint is server
 *     truth (which now includes the sale); offline, the refetch is paused by
 *     onlineManager and the delta'd base stands.
 *
 * Only ["products"] is patched: the app has no per-product query key
 * (inventory/[id] reads the list), so there is no detail cache to drift.
 * GET /api/products DOES send `updatedAt` per product (the api-client
 * Product type just does not declare it yet), so the §6.5 "server wins"
 * guard in applyDeltas is live: sales.tsx captures that stamp into the row's
 * `catalogUpdatedAt` sidecar at ring time, and a pending row keeps
 * decrementing a product only while the server still reports the same
 * stamp — never by comparing the device clock to the server's. A row with no
 * captured stamp is always subtracted; online a pending row lands within
 * seconds and triggers (3).
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { Product } from "@matgary/api-client";

import { useOffline } from "@/stores/offline";

import { applyDeltas, pendingDeltas } from "./local-delta";
import { list as listRows } from "./outbox";

export const PRODUCTS_KEY: QueryKey = ["products"];

/** Arrays this module wrote into the cache — recognised so its own writes are not taken as a new base. */
const ours = new WeakSet<object>();
let base: Product[] | null = null;
let doneSeen = new Set<string>();

function reapply(queryClient: QueryClient): void {
  if (!base) return;
  const rows = listRows();
  const next = applyDeltas(base, pendingDeltas(rows));
  const current = queryClient.getQueryData<Product[]>(PRODUCTS_KEY);
  if (current === next) return;
  if (next !== base) ours.add(next);
  // updatedAt: false — the base's own timestamp stands, so the query is
  // exactly as stale as the server answer it came from.
  queryClient.setQueryData<Product[]>(PRODUCTS_KEY, next, { updatedAt: queryClient.getQueryState(PRODUCTS_KEY)?.dataUpdatedAt });
}

/**
 * Re-derive and apply the delta right now. sales.tsx calls this straight
 * after enqueueing so the very next tap on a chip sees the reduced stock
 * (the revision subscriber would get there a tick later anyway).
 */
export function applyLocalDelta(queryClient: QueryClient): void {
  const data = queryClient.getQueryData<Product[]>(PRODUCTS_KEY);
  if (data && !ours.has(data)) base = data;
  reapply(queryClient);
}

export function attachLocalDelta(queryClient: QueryClient): () => void {
  const data = queryClient.getQueryData<Product[]>(PRODUCTS_KEY);
  if (Array.isArray(data) && !ours.has(data)) base = data;
  doneSeen = new Set(listRows().filter((r) => r.kind === "sale" && r.status === "done").map((r) => r.id));
  reapply(queryClient);

  const unsubCache = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "removed") {
      if (event.query.queryKey[0] === "products" && event.query.queryKey.length === 1) base = null;
      return;
    }
    if (event.type !== "updated" || event.action.type !== "success") return;
    const key = event.query.queryKey;
    if (key.length !== 1 || key[0] !== "products") return;
    const data = event.query.state.data;
    if (!Array.isArray(data) || ours.has(data)) return;
    base = data as Product[];
    reapply(queryClient);
  });

  let lastRevision = useOffline.getState().revision;
  const unsubStore = useOffline.subscribe((s) => {
    if (s.revision === lastRevision) return;
    lastRevision = s.revision;
    const rows = listRows();
    let landed = false;
    for (const r of rows) {
      if (r.kind === "sale" && r.status === "done" && !doneSeen.has(r.id)) {
        doneSeen.add(r.id);
        landed = true;
      }
    }
    reapply(queryClient);
    // Server truth replaces the local decrement (§6.5): one invalidation per
    // drain that landed something. Offline (simulated or real) the refetch is
    // paused by onlineManager and the delta'd cache stands.
    if (landed) void queryClient.invalidateQueries({ queryKey: PRODUCTS_KEY });
  });

  return () => {
    unsubCache();
    unsubStore();
  };
}
