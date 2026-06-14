"use client";

import { useCallback, useEffect, useState } from "react";
import type { SupplierDescriptor } from "@/lib/types";

interface ApiSupplier {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  balance: number;
  createdAt: string;
  updatedAt: string;
}

const fromApi = (s: ApiSupplier): SupplierDescriptor => ({
  ...s,
  createdAt: new Date(s.createdAt),
  updatedAt: new Date(s.updatedAt),
});

export function useSuppliers() {
  const [data, setData] = useState<SupplierDescriptor[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Cacheable per server Cache-Control (private, max-age=60, swr=300).
      const res = await fetch("/api/suppliers");
      if (res.status === 403) {
        // User can't see suppliers — surface empty list, not an error.
        setData([]);
        setError(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: { data: ApiSupplier[] } = await res.json();
      setData(json.data.map(fromApi));
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

  return { data, loading, error, refresh };
}
