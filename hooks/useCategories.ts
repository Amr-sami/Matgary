"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CategoryDescriptor } from "@/lib/types";

export function useCategories() {
  const [data, setData] = useState<CategoryDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // Cacheable per server Cache-Control (private, max-age=60, swr=300).
      const res = await fetch("/api/categories");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: { data: CategoryDescriptor[] } = await res.json();
      setData(json.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  return { data, byId, byKey, loading, error, refresh };
}
