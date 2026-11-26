/**
 * Digital collections — the ONE definition of every TanStack Query key of 03
 * §B.10, plus the hooks the POS panel, the inbox, the detail screen and the
 * settle sheet share (doc 15 spec 08 §4.14). Spec 09 imports `collectionKeys`
 * from here (its settings screens and `["collection-devices"]`); only this
 * file creates the keys.
 *
 * Snapshot: the root `collection-accounts` is in SNAPSHOT_ROOTS
 * (offline/snapshot.ts), so the accounts AND the branch settings (same root,
 * ARCH CR 4) are readable offline and `collectionsRequireAccount` is known
 * without a connection. `collections` / `collection-summary` are not
 * snapshotted: a stale inbox is worse than "needs a connection".
 */
import { useQuery, type QueryClient } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { collections, type me as meApi } from "@matgary/api-client";

import { api } from "@/api/client";
import { useOffline } from "@/stores/offline";
import { useSession } from "@/stores/session";

import { collectionAccess, type CollectionAccess } from "./rules";

export type CollectionListFilters = {
  status?: string;
  stale?: boolean;
  accountId?: string;
  sourceType?: collections.CollectionSourceType;
  invoiceId?: string;
  branchId?: string | null;
};

/** M2 (spec 07): the credits list filters. */
export type CreditListFilters = {
  state?: string;
  accountId?: string;
  branchId?: string | null;
};

export const collectionKeys = {
  accounts: (branchId: string | null) => ["collection-accounts", branchId] as const,
  /** GET collections/settings — same snapshot root as the accounts (ARCH CR 4). */
  settings: (branchId: string | null) => ["collection-accounts", branchId, "settings"] as const,
  list: (filters: CollectionListFilters) => ["collections", filters] as const,
  detail: (id: string) => ["collections", "detail", id] as const,
  byInvoice: (invoiceId: string) => ["collections", "invoice", invoiceId] as const,
  summary: (date: string, branchId: string | null) => ["collection-summary", date, branchId] as const,
  credits: (filters: CreditListFilters) => ["collection-credits", filters] as const,
  credit: (id: string) => ["collection-credits", "detail", id] as const,
  /**
   * M2 (order 21): the owner-only Unrecognised list (GET collections/unrecognised)
   * — an 08-internal sub-key under the credits root, like `detail`, so a paste's
   * invalidation of `["collection-credits"]` refreshes it too (an unknown-format
   * paste lands there). Not snapshotted (raw text never goes to disk).
   */
  unrecognised: () => ["collection-credits", "unrecognised"] as const,
  /** Spec 09 imports it from here. */
  devices: () => ["collection-devices"] as const,
};

const ALL_OFF: meApi.CollectionsFeatures = {
  collections: false,
  collectionsIngest: false,
  collectionsAutoConfirm: false,
  collectionsProviders: false,
  collectionsAvailable: false,
};

/** `me.features`; missing (an older server, or no session yet) → all false. */
export function useCollectionsFeatures(): meApi.CollectionsFeatures {
  const features = useSession((s) => s.me?.features);
  return features ? { ...ALL_OFF, ...features } : ALL_OFF;
}

export function useCollectionAccess(): CollectionAccess {
  const me = useSession((s) => s.me);
  return collectionAccess(me);
}

export function useActiveBranchId(): string | null {
  return useSession((s) => s.me?.branch?.id ?? null);
}

export type AccountsState = "ready" | "cached" | "unknown";

/**
 * The branch's receiving accounts (every member may read them: the cashier
 * shows the QR / number to the customer, 03 §E.5). The cache holds the
 * `{data, branchId}` envelope (that is what the snapshot keeps); the hook
 * hands back `.data`.
 *
 * `state`: "ready" = fresh from the server; "cached" = from the snapshot
 * while offline or after a failed refetch; "unknown" = nothing to show
 * (offline and never cached, or the first load failed) — the POS then does
 * not require a pick (08 §4.2 item 8).
 */
export function useCollectionAccounts(enabledOverride?: boolean) {
  const features = useCollectionsFeatures();
  const branchId = useActiveBranchId();
  const online = useOffline((s) => s.online);
  const enabled = enabledOverride ?? features.collections;
  const q = useQuery({
    queryKey: collectionKeys.accounts(branchId),
    queryFn: () => collections.listAccounts(api),
    enabled,
    staleTime: 5 * 60_000,
    select: (env) => env.data,
  });
  const accounts = q.data ?? null;
  const state: AccountsState = accounts
    ? online && !q.isError
      ? "ready"
      : "cached"
    : "unknown";
  return { accounts, state, isLoading: enabled && q.isLoading && online, query: q, branchId };
}

/** GET collections/settings for the active branch (any member). */
export function useCollectionSettings(enabledOverride?: boolean) {
  const features = useCollectionsFeatures();
  const branchId = useActiveBranchId();
  return useQuery({
    queryKey: collectionKeys.settings(branchId),
    queryFn: () => collections.getSettings(api),
    enabled: enabledOverride ?? features.collections,
    staleTime: 5 * 60_000,
  });
}

/**
 * Everything a decision (confirm / reject / reopen / settle) changes — the
 * rejection-to-debt path touches every one of these (03 §C.4).
 */
export function invalidateCollections(qc: QueryClient): Promise<unknown> {
  return Promise.all(
    [
      ["collections"],
      ["collection-summary"],
      ["sales"],
      ["dashboard"],
      ["customer-ledger"],
      ["customer-payments"],
      ["customers"],
      ["insights-overview"],
      // M2: a decision can drop a credit's candidate; a match / ignore moves the credit.
      ["collection-credits"],
    ].map((queryKey) => qc.invalidateQueries({ queryKey })),
  );
}

/**
 * An Idempotency-Key for one decision sheet: minted when the sheet OPENS and
 * reused for every tap and retry inside it, so a double tap or a lost
 * response replays instead of deciding twice (03 §C.8 rule 12). 36 chars fit
 * the server's `^[A-Za-z0-9_-]{8,64}$`.
 */
export function newIdempotencyKey(): string {
  return Crypto.randomUUID();
}

/** "YYYY-MM-DD" in the device's local time (no Intl on Hermes). */
export function localYmd(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Shift a "YYYY-MM-DD" by `days` (local calendar). */
export function shiftYmd(ymd: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
  d.setDate(d.getDate() + days);
  return localYmd(d);
}
