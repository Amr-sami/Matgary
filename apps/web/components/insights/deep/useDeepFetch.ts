"use client";

import { useEffect, useState } from "react";
import type { InsightsBranchScope, InsightsWindow } from "@/hooks/useInsights";

// Tiny fetcher hook shared by every deep-dive report. Each report builds a
// URL from its own `report` slug + report-specific params; the hook handles
// abort, loading state, and re-fetching when the window / branch changes.
//
// We intentionally re-fetch on every deps change without a stale-while-
// revalidate layer — the caller renders a lightweight skeleton and the
// endpoint itself is cached server-side.

export interface UseDeepFetchArgs {
  report: string;
  window: InsightsWindow | undefined;
  branchScope: InsightsBranchScope;
  /** Extra params merged into the query string. Undefined values are dropped. */
  extra?: Record<string, string | undefined>;
  /** Skip the fetch entirely — used when the caller has invalid inputs
   *  (e.g. product report with no productId selected yet). */
  enabled?: boolean;
}

export interface DeepFetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useDeepFetch<T>(args: UseDeepFetchArgs): DeepFetchState<T> {
  const { report, window, branchScope, extra, enabled = true } = args;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const fromKey = window?.from ? window.from.getTime() : null;
  const toKey = window?.to ? window.to.getTime() : null;
  const extraKey = extra
    ? Object.entries(extra)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join("&")
    : "";

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    setError(null);
    setLoading(true);

    const params = new URLSearchParams();
    params.set("report", report);
    if (fromKey != null && toKey != null) {
      params.set("from", new Date(fromKey).toISOString());
      params.set("to", new Date(toKey).toISOString());
    }
    if (branchScope) params.set("branchId", branchScope);
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined) params.set(k, v);
      }
    }

    (async () => {
      try {
        const res = await fetch(`/api/insights/deep?${params.toString()}`, {
          signal: ctrl.signal,
          cache: "no-store",
        });
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `request failed (${res.status})`);
        }
        const json = (await res.json()) as T;
        if (!cancelled) setData(json);
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, fromKey, toKey, branchScope, extraKey, enabled, reloadTick]);

  return {
    data,
    loading,
    error,
    reload: () => setReloadTick((n) => n + 1),
  };
}
