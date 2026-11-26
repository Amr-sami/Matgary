"use client";

// LEGACY SHIM — branches were removed as a product concept. This hook used
// to drive the header picker + per-user switching; now it only exists so
// that the handful of remaining callers (SaleForm, EmployeeFormModal, the
// collections pages) keep compiling while they transition to session-based
// branchId resolution.
//
// Returns the tenant's single primary branch — fetched via `/api/branches`,
// which now always returns a one-element list. `switchTo` is a no-op (there
// is nothing to switch to) and surfaces an error if a legacy caller still
// invokes it. The localStorage cache behaviour is preserved so the first
// paint doesn't flash.

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
    /* quota / private mode — ignore */
  }
};

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
  const [loading, setLoading] = useState(() => seed === null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/branches", { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 401) {
          setState({ branches: [], currentId: null });
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

  // Legacy signature. Switching is gone — calling this is a programming
  // error, not a product action. We reject loudly so a stray caller can be
  // found during QA rather than silently no-op.
  const switchTo = useCallback(async (_branchId: string) => {
    throw new Error(
      "Branch switching is not supported — Storo has no branches.",
    );
  }, []);

  const current = branches.find((b) => b.id === currentId) ?? branches[0] ?? null;

  return { branches, current, loading, error, refresh, switchTo };
}
