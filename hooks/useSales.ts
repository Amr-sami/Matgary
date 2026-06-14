"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { listSales } from "@/lib/api/sales";
import type { Sale } from "@/lib/types";

export interface UseSalesOptions {
  /** Bypass the server's default 60-day window and fetch full history.
   *  Set this on pages that aggregate over arbitrary date ranges
   *  (Reports). Default consumers (dashboards, POS, inventory dead-stock
   *  detection) leave it off and benefit from the smaller payload. */
  all?: boolean;
  /** Custom cutoff in days. Server clamps to [1, 730]. */
  days?: number;
}

/** Build a stable query key from the options. Same options on different
 *  consumers must produce the same key so TanStack Query deduplicates
 *  the in-flight request and shares the result. */
function salesQueryKey(opts: UseSalesOptions): readonly unknown[] {
  return ["sales", { all: !!opts.all, days: opts.days ?? null }] as const;
}

export function useSales(opts: UseSalesOptions = {}) {
  const qc = useQueryClient();
  const key = salesQueryKey(opts);

  const query = useQuery<Sale[]>({
    queryKey: key,
    queryFn: () => listSales({ all: opts.all, days: opts.days }),
    // 30 s staleTime is wider than the mount-cascade window (~hundreds of
    // ms when Suspense boundaries on /sales resume), so the 3+ co-mounted
    // useSales consumers on a page share one fetch instead of each
    // triggering its own. After a cart submit, mutation invalidation
    // forces a refetch regardless of staleness, so freshness isn't lost.
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });

  // Drop-in compatibility with the previous shape: { sales, loading,
  // error, refresh }. New consumers can call useQuery directly if they
  // want richer state (isFetching, isStale, etc.).
  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: key });
  }, [qc, key]);

  return {
    sales: query.data ?? [],
    loading: query.isPending,
    error: query.error ? query.error.message : null,
    refresh,
  };
}
