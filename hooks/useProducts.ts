"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
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

/** Shared key — every co-mounted consumer uses the same one so
 *  TanStack Query dedupes their fetches into a single network call. */
const PRODUCTS_QUERY_KEY = ["products"] as const;

async function fetchProducts(): Promise<Product[]> {
  // Always fresh on the WIRE: product.quantity changes on every sale,
  // so we keep `cache: "no-store"` on the underlying fetch. TanStack
  // Query's in-memory cache still dedupes co-mounted consumers; the
  // staleTime below controls when fresh data is required.
  const res = await fetch("/api/products", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json: { data: ProductRowApi[] } = await res.json();
  return json.data.map(reviveProduct);
}

export function useProducts() {
  const qc = useQueryClient();

  const query = useQuery<Product[]>({
    queryKey: PRODUCTS_QUERY_KEY,
    queryFn: fetchProducts,
    // 30 s wide enough to absorb the Suspense + child-component mount
    // cascade on /sales and /inventory (7 co-mounted consumers without
    // dedup before). Sale flow explicitly invalidates after each cart
    // submit, so the cashier never sees a stale quantity.
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });

  const refresh = useCallback(async (): Promise<Product[]> => {
    const fresh = await qc.fetchQuery<Product[]>({
      queryKey: PRODUCTS_QUERY_KEY,
      queryFn: fetchProducts,
      staleTime: 0,
    });
    return fresh;
  }, [qc]);

  return {
    products: query.data ?? [],
    loading: query.isPending,
    error: query.error ? query.error.message : null,
    refresh,
  };
}
