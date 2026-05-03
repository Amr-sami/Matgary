"use client";

import { useCallback, useEffect, useState } from "react";
import { listReturns } from "@/lib/api/returns";
import type { Return } from "@/lib/types";

export function useReturns() {
  const [returns, setReturns] = useState<Return[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await listReturns();
      setReturns(data);
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

  return { returns, loading, error, refresh };
}
