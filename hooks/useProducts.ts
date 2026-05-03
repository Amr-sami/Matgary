"use client";

import { useCallback, useEffect, useState } from "react";
import type { Product } from "@/lib/types";

interface ProductRowApi extends Omit<Product, "createdAt" | "updatedAt"> {
  createdAt: string;
  updatedAt: string;
}

function reviveProduct(p: ProductRowApi): Product {
  return {
    ...p,
    createdAt: new Date(p.createdAt),
    updatedAt: new Date(p.updatedAt),
  };
}

export function useProducts() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/products", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: { data: ProductRowApi[] } = await res.json();
      setProducts(json.data.map(reviveProduct));
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

  return { products, loading, error, refresh };
}
