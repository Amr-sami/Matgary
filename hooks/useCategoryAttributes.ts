"use client";

import { useCallback, useEffect, useState } from "react";
import type { CategoryAttribute } from "@/lib/types";

export function useCategoryAttributes(categoryId: string | null) {
  const [data, setData] = useState<CategoryAttribute[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!categoryId) {
      setData([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/categories/${categoryId}/attributes`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: { data: CategoryAttribute[] } = await res.json();
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
