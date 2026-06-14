"use client";

import { useCallback, useEffect, useState } from "react";
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

export function useSales(opts: UseSalesOptions = {}) {
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { all, days } = opts;

  const refresh = useCallback(async () => {
    try {
      const data = await listSales({ all, days });
      setSales(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ");
    } finally {
      setLoading(false);
    }
  }, [all, days]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { sales, loading, error, refresh };
}
