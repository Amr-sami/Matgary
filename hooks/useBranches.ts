"use client";

import { useCallback, useEffect, useState } from "react";

export interface BranchSummary {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  isActive: boolean;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

interface BranchesResponse {
  data: BranchSummary[];
  currentBranchId: string | null;
}

/** localStorage cache of the last-resolved branch list + active branch id.
 *  Seeds initial state on mount so the sidebar's store name doesn't flash
 *  through "متجري" → settings.shopName → branch name on every tab change.
 *  See the cache comments inside readCache / writeCache for the contract. */
const CACHE_KEY = "branches:v1";

interface CachedBranches {
  branches: BranchSummary[];
  currentBranchId: string | null;
}

const readCachedBranches = (): CachedBranches | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedBranches;
    // Defensive shape check — old cache shapes shouldn't crash the hook.
    if (!Array.isArray(parsed.branches)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const writeCachedBranches = (next: CachedBranches) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    // Quota / private mode — ignore; the network refresh below still
    // hydrates the UI within ~100ms.
  }
};

/**
 * Single source of truth for branch UI state on the client. Loads the user's
 * accessible branches plus which one is currently active (the active branch
 * lives in an HttpOnly cookie, so the server has to tell us). `switchTo`
 * flips the cookie and reloads the page so server-rendered pieces (sidebar
 * counts, server components) pick up the new context.
 *
 * Initial state is seeded from a localStorage cache (`branches:v1`) so the
 * sidebar's store name and the branch picker render the correct branch on
 * the very first paint after a navigation — no more
 * "متجري" → "Elhenawy Stores" → "Main" flicker on every tab change.
 */
/** Atomic state container — keeping branches + currentId in one object
 *  means `current = branches.find(b => b.id === currentId)` can never see
 *  a half-updated state where the array was swapped but the id wasn't
 *  (or vice versa). A naïve two-setState refresh occasionally rendered
 *  `current === null` for one frame, which made the sidebar's store name
 *  briefly fall back from "Main" to settings.shopName ("Elhenawy Stores")
 *  on every hard refresh. */
interface BranchesState {
  branches: BranchSummary[];
  currentId: string | null;
}

export function useBranches() {
  const seed = typeof window !== "undefined" ? readCachedBranches() : null;
  const [state, setState] = useState<BranchesState>(() => ({
    branches: seed?.branches ?? [],
    currentId: seed?.currentBranchId ?? null,
  }));
  // We only show the skeleton spinner on the very first ever load (no
  // cache yet). Subsequent navigations show the cached branch immediately
  // and silently refresh in the background.
  const [loading, setLoading] = useState(() => seed === null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/branches", { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 401) {
          setState({ branches: [], currentId: null });
          // Invalidate the cache so a logged-out tab doesn't carry the
          // previous user's branches into a future session.
          try {
            window.localStorage.removeItem(CACHE_KEY);
          } catch {
            /* ignore */
          }
          return;
        }
        throw new Error(`failed (${res.status})`);
      }
      const json = (await res.json()) as BranchesResponse;
      // Single setState = single re-render = no flicker through a
      // half-applied state.
      setState({
        branches: json.data,
        currentId: json.currentBranchId,
      });
      writeCachedBranches({
        branches: json.data,
        currentBranchId: json.currentBranchId,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const { branches, currentId } = state;

  const switchTo = useCallback(
    async (branchId: string) => {
      const res = await fetch("/api/branches/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "تعذر تبديل الفرع");
      }
      // Hard reload: server-rendered pieces (sidebar counters, server
      // components, the dashboard widgets) need to see the new active branch
      // immediately, and there's no clean way to invalidate every cached
      // hook in the tree.
      window.location.reload();
    },
    [],
  );

  const current = branches.find((b) => b.id === currentId) ?? null;

  return { branches, current, loading, error, refresh, switchTo };
}
