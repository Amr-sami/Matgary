"use client";

// Digital collections — TanStack Query hooks for the web (doc 15 spec 12
// §4.2). Query keys copy the phone's shapes (08 §4.14) so both apps mean the
// same thing: ["collections-config", branchId] · ["collections", filters] ·
// ["collections", "detail", id] · ["collection-summary", date, branchId] ·
// ["collections-pending-count", branchId]. A branch switch reloads the page
// (useBranches.switchTo), and the branch id in the keys comes from the
// localStorage cache that hook keeps — read here WITHOUT another
// /api/branches fetch.

import { useCallback, useMemo } from "react";
import { useSession } from "next-auth/react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type * as api from "@matgary/api-client/endpoints/collections";
import type { CollectionsFeatures } from "@matgary/api-client/endpoints/me";
import {
  confirmCollection,
  getCollection,
  getConfig,
  getSettings,
  getSummary,
  listCollections,
  rejectCollection,
  reopenCollection,
  updateCollection,
  updateSettings,
  type CollectionsConfig,
  type CollectionSettings,
} from "@/lib/api/collections";
import { readCollectionsSnapshot, writeCollectionsSnapshot } from "@/lib/offline/snapshot";
import { NO_FEATURES, collectionsAccess, type CollectionsAccess } from "@/components/collections/rules";
import { useDeferred } from "./useDeferred";

const BRANCH_CACHE_KEY = "branches:v1";

/** The active branch id from useBranches' localStorage cache (no fetch). */
export function readCachedBranchId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(BRANCH_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { currentBranchId?: string | null };
    return typeof parsed.currentBranchId === "string" ? parsed.currentBranchId : null;
  } catch {
    return null;
  }
}

export function useActiveBranchId(): string | null {
  // Stable for the page's life: a branch switch is a full reload.
  return useMemo(() => readCachedBranchId(), []);
}

function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

// ---- Config and access -------------------------------------------------------

export interface ConfigState {
  config: CollectionsConfig | null;
  source: "network" | "cache" | "none";
}

export function useCollectionsConfig() {
  const { data: session, status } = useSession();
  const tenantId = session?.user?.tenantId ?? null;
  const branchId = useActiveBranchId();
  const query = useQuery<ConfigState>({
    queryKey: ["collections-config", branchId],
    enabled: status === "authenticated" && !!tenantId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      try {
        const config = await getConfig();
        const bid = config.branchId || branchId;
        if (tenantId && bid) void writeCollectionsSnapshot("config", tenantId, bid, config);
        return { config, source: "network" };
      } catch (e) {
        if (!isNetworkError(e)) throw e;
        const cached =
          tenantId && branchId
            ? await readCollectionsSnapshot<CollectionsConfig>("config", tenantId, branchId)
            : null;
        return { config: cached, source: cached ? "cache" : "none" };
      }
    },
  });
  const features: CollectionsFeatures = query.data?.config?.features ?? NO_FEATURES;
  return {
    config: query.data?.config ?? null,
    source: query.data?.source ?? "none",
    features,
    loading: status === "loading" || (query.isPending && query.fetchStatus !== "idle"),
    error: query.error,
    refetch: query.refetch,
  };
}

export interface CollectionsAccessState extends CollectionsAccess {
  features: CollectionsFeatures;
  /** COLLECTIONS_ENABLED admits the shop (branch switch ignored) — ARCH CR 4. */
  available: boolean;
  config: CollectionsConfig | null;
  loading: boolean;
}

export function useCollectionsAccess(): CollectionsAccessState {
  const { data: session } = useSession();
  const cfg = useCollectionsConfig();
  const user = session?.user;
  const access = useMemo(
    () =>
      collectionsAccess(user ? { role: user.role, permissions: user.permissions ?? [] } : null, user?.id ?? null),
    [user],
  );
  return {
    ...access,
    features: cfg.features,
    available: cfg.features.collectionsAvailable === true,
    config: cfg.config,
    loading: cfg.loading,
  };
}

// ---- Settings ----------------------------------------------------------------

export function useCollectionSettings(branchId: string | null, enabled = true) {
  return useQuery<CollectionSettings>({
    // Under the accounts prefix, as the phone (03 §B.10): one invalidation
    // refreshes the switches and the account list together.
    queryKey: ["collection-accounts", branchId, "settings"],
    queryFn: () => getSettings(branchId ?? undefined),
    enabled,
  });
}

// ---- Lists, detail, summary --------------------------------------------------

export function useCollectionsList(query: api.ListCollectionsParams | null, enabled = true) {
  return useInfiniteQuery({
    queryKey: ["collections", query ?? {}],
    enabled: enabled && query != null,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => listCollections({ ...(query ?? {}), cursor: pageParam, limit: 50 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 15_000,
  });
}

export function useCollection(id: string | null) {
  return useQuery({
    queryKey: ["collections", "detail", id],
    queryFn: () => getCollection(id as string),
    enabled: !!id,
    staleTime: 5_000,
  });
}

export function useCollectionsSummary(date: string, branchId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["collection-summary", date, branchId],
    queryFn: () => getSummary({ date, branchId: branchId ?? undefined }),
    enabled,
    staleTime: 15_000,
  });
}

const PENDING_POLL_MS = 60_000;

/** The nav badge: `counts.pending` of a 1-row page, polled every 60 s. */
export function usePendingCollectionsCount() {
  const { features, canView } = useCollectionsAccess();
  const branchId = useActiveBranchId();
  const armed = useDeferred(2000);
  const q = useQuery({
    queryKey: ["collections-pending-count", branchId],
    queryFn: async () => (await listCollections({ status: "pending", limit: 1 })).counts,
    enabled: armed && features.collections && canView,
    refetchInterval: PENDING_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: PENDING_POLL_MS / 2,
  });
  return { count: q.data?.pending ?? 0, stale: q.data?.stale ?? 0, refresh: q.refetch };
}

// ---- Decisions ---------------------------------------------------------------

/** Every view a decision (or a digital settle) can change. */
export function invalidateAfterDecision(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["collections"] }),
    qc.invalidateQueries({ queryKey: ["collection-summary"] }),
    qc.invalidateQueries({ queryKey: ["collections-pending-count"] }),
    qc.invalidateQueries({ queryKey: ["collection-credits"] }),
    qc.invalidateQueries({ queryKey: ["sales"] }),
  ]);
}

export function useCollectionDecision() {
  const qc = useQueryClient();
  const done = useCallback(() => invalidateAfterDecision(qc), [qc]);
  const confirm = useMutation({
    mutationFn: (v: { id: string; key: string; note?: string }) =>
      confirmCollection(v.id, v.note ? { note: v.note } : {}, v.key),
    onSuccess: done,
  });
  const reject = useMutation({
    mutationFn: (v: { id: string; key: string; body: api.RejectCollectionBody }) =>
      rejectCollection(v.id, v.body, v.key),
    onSuccess: done,
  });
  const reopen = useMutation({
    mutationFn: (v: { id: string; key: string; note?: string }) =>
      reopenCollection(v.id, v.note ? { note: v.note } : {}, v.key),
    onSuccess: done,
  });
  const edit = useMutation({
    mutationFn: (v: { id: string; body: api.UpdateCollectionBody }) => updateCollection(v.id, v.body),
    onSuccess: done,
  });
  return { confirm, reject, reopen, edit };
}

export function useUpdateCollectionSettings(branchId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: api.CollectionSettingsPatch) => updateSettings(patch, branchId ?? undefined),
    onSuccess: async (next, patch) => {
      qc.setQueryData(["collection-accounts", branchId, "settings"], next);
      if ("collectionsEnabled" in patch || "collectionsAutoConfirmEnabled" in patch) {
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["collections-config"] }),
          qc.invalidateQueries({ queryKey: ["collection-accounts"] }),
          qc.invalidateQueries({ queryKey: ["collections-pending-count"] }),
        ]);
      }
    },
  });
}
