"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useCategories } from "@/hooks/useCategories";
import type { CategoryDescriptor, Product } from "@/lib/types";

interface CatalogContextValue {
  categoryById: Record<string, CategoryDescriptor>;
  /** Category label fallback that always returns *something* renderable. */
  categoryLabel: (product: Pick<Product, "category">) => string;
  /** Snapshot of an attribute label for a given product (e.g. gender). */
  attributeLabel: (
    product: Pick<Product, "attributes">,
    attributeKey: string,
  ) => string;
}

const CatalogContext = createContext<CatalogContextValue | null>(null);

export function CatalogProvider({ children }: { children: ReactNode }) {
  const { byId, data } = useCategories();

  const value = useMemo<CatalogContextValue>(() => {
    return {
      categoryById: byId,
      categoryLabel: (p) => byId[p.category]?.label ?? "—",
      attributeLabel: (p, key) => p.attributes?.[key] ?? "—",
    };
    // include data so the memo updates when the list arrives
  }, [byId, data]);

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog() {
  const ctx = useContext(CatalogContext);
  if (!ctx) {
    // Degraded fallback when no provider is mounted (legacy pages we haven't
    // wrapped yet) — prevents render crashes during the migration.
    return {
      categoryById: {} as Record<string, CategoryDescriptor>,
      categoryLabel: () => "—",
      attributeLabel: () => "—",
    } satisfies CatalogContextValue;
  }
  return ctx;
}
