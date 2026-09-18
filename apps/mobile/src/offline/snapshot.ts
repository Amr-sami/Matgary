/**
 * Read-path snapshots for TanStack Query (doc 06 §6.2 / §5.5).
 *
 * The POS, inventory, dashboard and customers screens all read through
 * `useQuery`. This module watches the QueryCache and copies every SUCCESSFUL
 * fetch of an allow-listed key into the offline engine's snapshot table
 * (`saveSnapshot`, tenant-scoped, wiped on sign-out), so `hydrate.ts` can put
 * the last good answer back into the cache at the next launch and the
 * screens paint with no signal. Staleness is never hidden: the stored
 * `updatedAt` becomes the query's `dataUpdatedAt`, and `useSnapshotAge()`
 * (hydrate.ts) feeds the chip.
 *
 * Pure by design — no runtime imports — so
 *   node --test --experimental-strip-types apps/mobile/src/offline/__tests__/snapshot.test.ts
 * exercises the key matching, size cap and eviction. The SQLite / zustand
 * side lives in `hydrate.ts` (`snapshotIO`), injected as `SnapshotIO`.
 *
 * Storage layout (all keys pass through the engine's tenant prefix):
 *   rq-index:<branch>          → Manifest  { [hash]: { key, bytes, updatedAt } }
 *   rq:<branch>:<hash>         → the query's data
 * Query keys in this app do not carry the branch (the client sends
 * X-Branch-Id), so the branch is part of the storage key here, and the
 * branch is captured when a FETCH STARTS (see the subscriber), not when its
 * response lands: a branch-A answer that arrives after the switch to B is
 * filed under A, so switching branch offline can never surface the other
 * branch's products.
 *
 * /api/me is not a query and is not kept here: the session store caches the
 * last good MeResponse itself (stores/session.ts) so a cold offline launch
 * can restore the session before anything in this table is readable.
 */
import type { QueryCacheNotifyEvent, QueryClient, QueryKey } from "@tanstack/react-query";

// ─── what is snapshotted ─────────────────────────────────────────────────────

/**
 * First element of every query key the read path keeps. Everything else
 * (insights, activity, attendance, notifications, whatsapp …) is either
 * worthless when stale or cheap to refetch (doc 06 §5.5 NEVER_PERSIST).
 */
export const SNAPSHOT_ROOTS: readonly string[] = [
  "products", // POS + inventory + purchases
  "categories",
  "brands",
  "suppliers",
  "customers",
  "sales", // the POS "recent sales" strip
  "dashboard",
  "shop-settings", // receipt / store settings
  "branches",
];

/** Bytes of JSON one entry may occupy; bigger answers are not kept (and are reported via `onDropped`). */
export const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
/**
 * The catalogue is the one answer the offline POS cannot do without, and it
 * measures ~350 B/product on the live API: 2 MB would silently drop shops
 * with ~6,000 products — the ones most dependent on an offline till.
 */
export const MAX_PRODUCTS_ENTRY_BYTES = 6 * 1024 * 1024;
/** Bytes of JSON all entries of one (tenant, branch) may occupy together. */
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
/** Trailing debounce for the write burst a screen mount produces. */
export const DEBOUNCE_MS = 500;
/** A burst that never quiets still flushes this often. */
export const MAX_WAIT_MS = 3_000;
/** Hydrated queries must outlive the default 5-min GC or the POS opened later finds nothing. */
export const SNAPSHOT_GC_TIME_MS = 24 * 60 * 60 * 1000;

export function isSnapshotKey(queryKey: QueryKey, roots: readonly string[] = SNAPSHOT_ROOTS): boolean {
  if (!Array.isArray(queryKey) || queryKey.length === 0) return false;
  const root = queryKey[0];
  return typeof root === "string" && roots.includes(root);
}

// ─── pure helpers ────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
}

/** Same algorithm as TanStack's `hashKey`: JSON with object keys sorted. */
export function hashQueryKey(queryKey: QueryKey): string {
  return JSON.stringify(queryKey, (_, val: unknown) =>
    isPlainObject(val)
      ? Object.keys(val)
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = val[k];
            return acc;
          }, {})
      : val,
  );
}

/** UTF-8 byte length without TextEncoder (Hermes-safe, Node-safe). */
export function utf8Bytes(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4; // surrogate pair = one 4-byte code point
      i++;
    } else bytes += 3;
  }
  return bytes;
}

export function dataKey(branch: string, hash: string): string {
  return `rq:${branch}:${hash}`;
}

export function manifestKey(branch: string): string {
  return `rq-index:${branch}`;
}

export interface ManifestEntry {
  key: QueryKey;
  bytes: number;
  updatedAt: number;
}
export type Manifest = Record<string, ManifestEntry>;

export interface PendingWrite {
  hash: string;
  key: QueryKey;
  data: unknown;
  /** Serialised once here — that is what the size cap measures. */
  json: string;
  bytes: number;
  updatedAt: number;
}

export interface WritePlan {
  manifest: Manifest;
  /** Entries to persist, in order. */
  writes: PendingWrite[];
  /** Hashes whose data must be deleted (evicted for space). */
  evict: string[];
  /** Hashes skipped because one entry alone is over the cap. */
  tooBig: string[];
  /** The same entries as `tooBig`, with the key and size, for the caller to surface. */
  dropped: Array<{ key: QueryKey; bytes: number }>;
}

export interface Caps {
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** Per-root overrides of `maxEntryBytes`, keyed by the query key's first element. */
  maxEntryBytesByRoot?: Readonly<Record<string, number>>;
}

export const DEFAULT_CAPS: Caps = {
  maxEntryBytes: MAX_ENTRY_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxEntryBytesByRoot: { products: MAX_PRODUCTS_ENTRY_BYTES },
};

function entryCap(caps: Caps, key: QueryKey): number {
  const root = key[0];
  const override = typeof root === "string" ? caps.maxEntryBytesByRoot?.[root] : undefined;
  return override ?? caps.maxEntryBytes;
}

/**
 * Serialise a batch of successful query results into writes that respect
 * the caps. Over-cap entries are dropped (and any older copy evicted, so a
 * catalogue that outgrew the cap never leaves a stale small one behind).
 * When the batch plus the existing manifest exceeds the total budget, the
 * OLDEST entries not in this batch go first, then the oldest of the batch.
 */
export function planWrites(
  manifest: Manifest,
  incoming: Array<{ key: QueryKey; data: unknown; updatedAt: number }>,
  caps: Caps = DEFAULT_CAPS,
): WritePlan {
  const next: Manifest = { ...manifest };
  const writes: PendingWrite[] = [];
  const evict = new Set<string>();
  const tooBig: string[] = [];
  const dropped: WritePlan["dropped"] = [];
  const fresh = new Set<string>();

  for (const item of incoming) {
    const hash = hashQueryKey(item.key);
    let json: string;
    try {
      json = JSON.stringify(item.data ?? null);
    } catch {
      continue; // cyclic or otherwise unserialisable — not a snapshot
    }
    if (typeof json !== "string") continue;
    const bytes = utf8Bytes(json);
    if (bytes > entryCap(caps, item.key)) {
      tooBig.push(hash);
      dropped.push({ key: item.key, bytes });
      if (next[hash]) {
        delete next[hash];
        evict.add(hash);
      }
      continue;
    }
    // Last write for the same key in one batch wins.
    const dupAt = writes.findIndex((w) => w.hash === hash);
    if (dupAt >= 0) writes.splice(dupAt, 1);
    writes.push({ hash, key: item.key, data: item.data ?? null, json, bytes, updatedAt: item.updatedAt });
    next[hash] = { key: item.key, bytes, updatedAt: item.updatedAt };
    fresh.add(hash);
  }

  // Total budget: evict oldest, preferring entries this batch did not touch.
  let total = Object.values(next).reduce((n, e) => n + e.bytes, 0);
  if (total > caps.maxTotalBytes) {
    const order = Object.entries(next).sort((a, b) => {
      const aFresh = fresh.has(a[0]) ? 1 : 0;
      const bFresh = fresh.has(b[0]) ? 1 : 0;
      if (aFresh !== bFresh) return aFresh - bFresh;
      return a[1].updatedAt - b[1].updatedAt;
    });
    for (const [hash, entry] of order) {
      if (total <= caps.maxTotalBytes) break;
      delete next[hash];
      evict.add(hash);
      total -= entry.bytes;
      const w = writes.findIndex((x) => x.hash === hash);
      if (w >= 0) writes.splice(w, 1);
    }
  }

  // An evicted hash that is also being written would be contradictory; the
  // eviction loop above already removed its write, so nothing to reconcile.
  return { manifest: next, writes, evict: [...evict], tooBig, dropped };
}

// ─── IO boundary ─────────────────────────────────────────────────────────────

/** The engine functions this module needs, injected so it stays pure. */
export interface SnapshotIO {
  save: (key: string, data: unknown) => void;
  /** Write an already-serialised value; `planWrites` has the JSON in hand, so the engine need not encode it twice. */
  saveJson?: (key: string, json: string) => void;
  read: <T>(key: string) => { data: T; updatedAt: number } | null;
  remove: (key: string) => void;
  /** Run `fn` atomically (one SQLite transaction). Absent → the plan is applied statement by statement. */
  transact?: (fn: () => void) => void;
  /** Entries a flush could not keep because one answer alone was over its cap. */
  onDropped?: (dropped: Array<{ key: QueryKey; bytes: number }>) => void;
  /** The chip's "last synced": called once per successful server read. */
  touchLastSynced: () => void;
  /** Current branch id, or null when nobody is signed in (→ nothing is written). */
  scope: () => string | null;
  now?: () => number;
}

export function readManifest(io: SnapshotIO, branch: string): Manifest {
  const row = io.read<unknown>(manifestKey(branch));
  const m = row?.data;
  if (!isPlainObject(m)) return {};
  const out: Manifest = {};
  for (const [hash, e] of Object.entries(m)) {
    if (isPlainObject(e) && Array.isArray(e.key) && typeof e.bytes === "number" && typeof e.updatedAt === "number") {
      out[hash] = { key: e.key as QueryKey, bytes: e.bytes, updatedAt: e.updatedAt };
    }
  }
  return out;
}

/**
 * Apply a plan to storage. Returns how many entries were written.
 *
 * Atomic when the engine offers `transact`. Without it the manifest goes
 * FIRST: `hydrate.ts` tolerates an index entry whose row is missing (a
 * write that never happened), but a row without an index entry would be an
 * orphan nothing reads or evicts until the sign-out wipe.
 */
export function commitPlan(io: SnapshotIO, branch: string, plan: WritePlan): number {
  const run = () => {
    if (plan.writes.length || plan.evict.length) io.save(manifestKey(branch), plan.manifest);
    for (const hash of plan.evict) io.remove(dataKey(branch, hash));
    for (const w of plan.writes) {
      if (io.saveJson) io.saveJson(dataKey(branch, w.hash), w.json);
      else io.save(dataKey(branch, w.hash), w.data);
    }
  };
  if (io.transact) io.transact(run);
  else run();
  return plan.writes.length;
}

/**
 * Persist a batch of successful results for `branch` — the debounced flush
 * and the /me mirror both come through here.
 */
export function persistResults(
  io: SnapshotIO,
  branch: string,
  incoming: Array<{ key: QueryKey; data: unknown; updatedAt: number }>,
  caps?: Caps,
): WritePlan {
  const plan = planWrites(readManifest(io, branch), incoming, caps);
  commitPlan(io, branch, plan);
  if (plan.dropped.length && io.onDropped) {
    try {
      io.onDropped(plan.dropped);
    } catch {
      /* reporting is best-effort */
    }
  }
  return plan;
}

// ─── the QueryCache subscriber ───────────────────────────────────────────────

export interface SubscriberOptions {
  roots?: readonly string[];
  caps?: Caps;
  debounceMs?: number;
  maxWaitMs?: number;
  /** Test seam: defaults to global setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface SnapshotSubscriber {
  /** Write whatever is pending right now. */
  flush: () => void;
  /** Stop listening; flushes first. */
  detach: () => void;
  /** Persist data that did not come through the cache (the session's /me). */
  persist: (key: QueryKey, data: unknown) => void;
}

/**
 * Decide from one cache event whether it is a real server success we keep.
 * `manual` successes are `setQueryData` calls — optimistic patches and our
 * own hydration — and are skipped: the server's answer follows them anyway.
 */
export function isPersistableEvent(event: QueryCacheNotifyEvent, roots: readonly string[] = SNAPSHOT_ROOTS): boolean {
  if (event.type !== "updated") return false;
  if (event.action.type !== "success") return false;
  if (event.action.manual) return false;
  if (event.query.state.status !== "success") return false;
  if (event.query.state.data === undefined) return false;
  return isSnapshotKey(event.query.queryKey, roots);
}

export function attachSnapshotSubscriber(queryClient: QueryClient, io: SnapshotIO, opts: SubscriberOptions = {}): SnapshotSubscriber {
  const roots = opts.roots ?? SNAPSHOT_ROOTS;
  const caps = opts.caps ?? DEFAULT_CAPS;
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const now = io.now ?? (() => Date.now());

  // hash → pending item, keyed per branch so a switch mid-burst cannot
  // file one branch's products under the other.
  const pending = new Map<string, Map<string, { key: QueryKey; data: unknown; updatedAt: number }>>();
  // queryHash → the branch the header carried when that fetch STARTED. The
  // keys themselves do not name the branch, so this is the only way to file
  // a response that lands after a switch under the branch it belongs to.
  const fetchScope = new Map<string, string | null>();
  let debounceId: unknown = null;
  let maxWaitId: unknown = null;

  const clearTimers = () => {
    if (debounceId !== null) clearTimer(debounceId);
    if (maxWaitId !== null) clearTimer(maxWaitId);
    debounceId = null;
    maxWaitId = null;
  };

  const flush = () => {
    clearTimers();
    if (pending.size === 0) return;
    const batches = [...pending.entries()];
    pending.clear();
    for (const [branch, items] of batches) {
      try {
        persistResults(io, branch, [...items.values()], caps);
      } catch {
        // SQLite hiccup: the cache is still the live source; the next
        // success re-queues the key. Never throw into TanStack's notify.
      }
    }
  };

  const schedule = () => {
    if (debounceId !== null) clearTimer(debounceId);
    debounceId = setTimer(flush, debounceMs);
    if (maxWaitId === null) maxWaitId = setTimer(flush, maxWaitMs);
  };

  const queue = (key: QueryKey, data: unknown, updatedAt: number, branch: string | null = io.scope()) => {
    if (!branch) return;
    let bucket = pending.get(branch);
    if (!bucket) {
      bucket = new Map();
      pending.set(branch, bucket);
    }
    bucket.set(hashQueryKey(key), { key, data, updatedAt });
    schedule();
  };

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "fetch" && isSnapshotKey(event.query.queryKey, roots)) {
      fetchScope.set(event.query.queryHash, io.scope());
      return;
    }
    if (event.type === "removed") {
      fetchScope.delete(event.query.queryHash);
      return;
    }
    if (!isPersistableEvent(event, roots)) return;
    try {
      io.touchLastSynced();
    } catch {
      /* the chip is cosmetic */
    }
    const hash = event.query.queryHash;
    const branch = fetchScope.has(hash) ? fetchScope.get(hash)! : io.scope();
    fetchScope.delete(hash);
    queue(event.query.queryKey, event.query.state.data, event.query.state.dataUpdatedAt || now(), branch);
  });

  return {
    flush,
    detach: () => {
      unsubscribe();
      flush();
    },
    persist: (key, data) => {
      if (!isSnapshotKey(key, roots)) return;
      queue(key, data, now());
    },
  };
}
