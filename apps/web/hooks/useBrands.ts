"use client";

import { useCallback, useEffect, useState } from "react";
import type { BrandDescriptor } from "@/lib/types";

export function useBrands(categoryId?: string | null) {
  const [data, setData] = useState<BrandDescriptor[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const url = categoryId
        ? `/api/brands?categoryId=${encodeURIComponent(categoryId)}`
        : "/api/brands";
      // Cacheable per server Cache-Control (private, max-age=60, swr=300).
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: { data: BrandDescriptor[] } = await res.json();
      setData(json.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ");
    } finally {
      setLoading(false);
    }
  }, [categoryId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}
