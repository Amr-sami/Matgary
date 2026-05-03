"use client";

import { useCallback, useEffect, useState } from "react";
import { listSales } from "@/lib/api/sales";
import type { Sale } from "@/lib/types";

export function useSales() {
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await listSales();
      setSales(data);
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

  return { sales, loading, error, refresh };
}
