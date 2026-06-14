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

  /**
   * Re-fetch the product list. Returns the new list directly so callers
   * who need to act on the fresh data (e.g. selecting a just-created
   * product) don't have to wait for React to commit the state update
   * before reading from `products`.
   */
  const refresh = useCallback(async (): Promise<Product[]> => {
    try {
      // Always fresh: product.quantity changes on every sale and a
      // stale browser cache would mislead the cashier on remaining stock.
      const res = await fetch("/api/products", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: { data: ProductRowApi[] } = await res.json();
      const revived = json.data.map(reviveProduct);
      setProducts(revived);
      setError(null);
      return revived;
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ");
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { products, loading, error, refresh };
}
