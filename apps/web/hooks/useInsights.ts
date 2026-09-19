"use client";

import { useEffect, useState } from "react";

// All aggregation now lives in the server route `/api/insights/overview`. The
// browser used to download every sale, return, expense, and product just to
// compute six numbers — for a tenant with 50k sales that was multiple MB of
// JSON over the wire on every page load.
//
// The hook here is intentionally small: it just fetches, validates the shape
// the route promises, and re-fetches when the date window changes.

export interface InsightsWindow {
  /** Start of the analysed period, inclusive. Undefined = open-ended. */
  from?: Date;
  /** End of the analysed period, inclusive. Undefined = now. */
  to?: Date;
}

export interface InsightsOverviewData {
  window: { from: string; to: string } | null;
  metrics: {
    currentRevenue: number;
    lastRevenue: number;
    revenueGrowth: number;
    totalRevenue: number;
    totalCostOfGoods: number;
    totalExpenses: number;
    grossProfit: number;
    netProfit: number;
    totalDiscounts: number;
    discountPercent: number;
    totalSales: number;
    totalReturns: number;
  };
  trendData: Array<{ date: string; revenue: number; count?: number }>;
  topProducts: Array<{
    id: string;
    name: string;
    brand?: string;
    qty: number;
    revenue: number;
  }>;
  categoryChartData: Array<{ name: string; value: number }>;
}

/** Branch scope for the overview fetch.
 *  - undefined → server defaults to the active branch from the cookie.
 *  - "all" → aggregate every branch (owner only on the server).
 *  - <uuid> → restrict to that branch. */
export type InsightsBranchScope = string | "all" | undefined;

export function useInsights(
  window?: InsightsWindow,
  branchScope?: InsightsBranchScope,
) {
  const [data, setData] = useState<InsightsOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Stable dependency keys so we don't re-fetch on every parent render.
  const fromKey = window?.from ? window.from.getTime() : null;
  const toKey = window?.to ? window.to.getTime() : null;

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setError(null);
    // Show the skeleton only when we have no data yet. Subsequent
    // window-change refreshes keep the previous render visible until the new
    // payload arrives — no blank-page flicker between filter clicks. Without
    // this guard React Strict Mode's double-effect (dev only) aborts the
    // first fetch, the `finally` still flips loading=false, and the page's
    // `if (!data) return null` paints a blank frame.
    setLoading((prev) => (data == null ? true : prev));

    const params = new URLSearchParams();
    // Only send a window when both endpoints are present — the route rejects
    // a half-open range. "All time" is "no params at all".
    if (fromKey != null && toKey != null) {
      params.set("from", new Date(fromKey).toISOString());
      params.set("to", new Date(toKey).toISOString());
    }
    if (branchScope) params.set("branchId", branchScope);
    const url =
      "/api/insights/overview" +
      (params.toString() ? `?${params.toString()}` : "");

    (async () => {
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          cache: "no-store",
        });
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `request failed (${res.status})`);
        }
        const json = (await res.json()) as InsightsOverviewData;
        if (cancelled) return;
        setData(json);
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "حدث خطأ");
        // Deliberately don't `setData(null)` — keep the last successful
        // render visible alongside the error so the user isn't dumped onto
        // a blank page.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // `data` is intentionally excluded from deps — including it would re-run
    // the fetch every time the response lands. We only read its current value
    // to decide whether to show the skeleton on this run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromKey, toKey, branchScope]);

  return { data, loading, error };
}
