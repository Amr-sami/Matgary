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

/**
 * Single source of truth for branch UI state on the client. Loads the user's
 * accessible branches plus which one is currently active (the active branch
 * lives in an HttpOnly cookie, so the server has to tell us). `switchTo`
 * flips the cookie and reloads the page so server-rendered pieces (sidebar
 * counts, server components) pick up the new context.
 */
export function useBranches() {
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/branches", { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 401) {
          setBranches([]);
          setCurrentId(null);
          return;
        }
        throw new Error(`failed (${res.status})`);
      }
      const json = (await res.json()) as BranchesResponse;
      setBranches(json.data);
      setCurrentId(json.currentBranchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
