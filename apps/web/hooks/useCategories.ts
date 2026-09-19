"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { CategoryDescriptor } from "@/lib/types";

const CATEGORIES_QUERY_KEY = ["categories"] as const;

async function fetchCategories(): Promise<CategoryDescriptor[]> {
  // Cacheable per server Cache-Control (private, max-age=60, swr=300).
  // The browser cache + TanStack Query's in-memory cache compose: even
  // a tab opened seconds after another sees no network roundtrip.
  const res = await fetch("/api/categories");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json: { data: CategoryDescriptor[] } = await res.json();
  return json.data;
}

export function useCategories() {
  const qc = useQueryClient();

  // Widest fan-out hook in the app (10 consumers across CRUD modals +
  // pages). Without dedup, every modal mount fires its own fetch even
  // though categories only change when the owner edits them.
  const query = useQuery<CategoryDescriptor[]>({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: fetchCategories,
    // Categories are slow-changing structural data. 5 min is generous
    // — when the owner edits them, the editor calls refresh() which
    // invalidates the cache via mutation semantics, so the long
    // staleTime doesn't cause user-visible staleness.
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });

  const data = query.data ?? [];

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY });
  }, [qc]);

  const byId = useMemo(() => {
    const m: Record<string, CategoryDescriptor> = {};
    for (const c of data) m[c.id] = c;
    return m;
  }, [data]);

  const byKey = useMemo(() => {
    const m: Record<string, CategoryDescriptor> = {};
    for (const c of data) m[c.key] = c;
    return m;
  }, [data]);

  return {
    data,
    byId,
    byKey,
    loading: query.isPending,
    error: query.error ? query.error.message : null,
    refresh,
  };
}
