"use client";

import { cn } from "@/lib/utils";
import type { Category, Gender, CategoryDescriptor } from "@/lib/types";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

export type StockStatus = "in" | "low" | "out";

/**
 * Back-compat export for callers that haven't been migrated to use the dict.
 * New code should pull labels from `dict.app.inventory.filters.stockStatus`.
 */
export const STOCK_STATUS_LABELS: Record<StockStatus, string> = {
  in: "متوفر",
  low: "مخزون منخفض",
  out: "نفذ",
};

interface InventoryFiltersProps {
  /** Per-tenant category list — drives both the filter buttons and the labels. */
  categoryOptions: CategoryDescriptor[];
  selectedCategory: Category | null;
  onCategoryChange: (category: Category | null) => void;
  /** Distinct gender labels surfaced from the loaded products' attributes. */
  genderOptions: string[];
  selectedGender: Gender | null;
  onGenderChange: (gender: Gender | null) => void;
  selectedBrand: string | null;
  onBrandChange: (brand: string | null) => void;
  brands: string[];
  selectedStockStatus: StockStatus | null;
  onStockStatusChange: (status: StockStatus | null) => void;
  minPrice: string;
  maxPrice: string;
  onMinPriceChange: (value: string) => void;
  onMaxPriceChange: (value: string) => void;
  tags: string[];
  selectedTag: string | null;
  onTagChange: (tag: string | null) => void;
  suppliers: string[];
  selectedSupplier: string | null;
  onSupplierChange: (supplier: string | null) => void;
}

export function InventoryFilters({
  categoryOptions,
  selectedCategory,
  onCategoryChange,
  genderOptions,
  selectedGender,
  onGenderChange,
  selectedBrand,
  onBrandChange,
  brands,
  selectedStockStatus,
  onStockStatusChange,
  minPrice,
  maxPrice,
  onMinPriceChange,
  onMaxPriceChange,
  tags,
  selectedTag,
  onTagChange,
  suppliers,
  selectedSupplier,
  onSupplierChange,
}: InventoryFiltersProps) {
  const dict = useDictionary();
  const t = dict.app.inventory.filters;
  const stockStatuses: (StockStatus | null)[] = [null, "in", "low", "out"];

  return (
    <div className="space-y-3">
      {/* Category Filter */}
      <div className="flex flex-wrap gap-2">
        <button
          key="cat-all"
          onClick={() => onCategoryChange(null)}
          className={cn(
            "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
            selectedCategory === null
              ? "bg-accent text-white"
              : "bg-white border border-border text-text-secondary hover:border-accent",
          )}
        >
          {t.allCategories}
        </button>
        {categoryOptions.map((cat) => (
          <button
            key={cat.id}
            onClick={() => onCategoryChange(cat.id)}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
              selectedCategory === cat.id
                ? "bg-accent text-white"
                : "bg-white border border-border text-text-secondary hover:border-accent",
            )}
            dir="auto"
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Gender Filter — only render when at least one product surfaces a gender attribute */}
      {genderOptions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            key="g-all"
            onClick={() => onGenderChange(null)}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
              selectedGender === null
                ? "bg-accent text-white"
                : "bg-white border border-border text-text-secondary hover:border-accent",
            )}
          >
            {t.allGenders}
          </button>
          {genderOptions.map((g) => (
            <button
              key={g}
              onClick={() => onGenderChange(g)}
              className={cn(
                "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                selectedGender === g
                  ? "bg-accent text-white"
                  : "bg-white border border-border text-text-secondary hover:border-accent",
              )}
              dir="auto"
            >
              {g}
            </button>
          ))}
        </div>
      )}

      {/* Stock Status Filter */}
      <div className="flex flex-wrap gap-2">
        {stockStatuses.map((s) => (
          <button
            key={s ?? "all"}
            onClick={() => onStockStatusChange(s)}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
              selectedStockStatus === s
                ? "bg-accent text-white"
                : "bg-white border border-border text-text-secondary hover:border-accent"
            )}
          >
            {s ? t.stockStatus[s] : t.allStatuses}
          </button>
        ))}
      </div>

      {/* Brand + Supplier + Price filters */}
      <div className="flex flex-wrap gap-2">
        {brands.length > 0 && (
          <select
            value={selectedBrand || ""}
            onChange={(e) => onBrandChange(e.target.value || null)}
            className="px-3 py-2 rounded-lg border border-border bg-white text-sm"
            dir="auto"
          >
            <option value="">{t.allBrands}</option>
            {brands.map((brand) => (
              <option key={brand} value={brand}>
                {brand}
              </option>
            ))}
          </select>
        )}
        {suppliers.length > 0 && (
          <select
            value={selectedSupplier || ""}
            onChange={(e) => onSupplierChange(e.target.value || null)}
            className="px-3 py-2 rounded-lg border border-border bg-white text-sm"
            dir="auto"
          >
            <option value="">{t.allSuppliers}</option>
            {suppliers.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        <input
          type="number"
          min={0}
          inputMode="numeric"
          placeholder={t.minPrice}
          value={minPrice}
          onChange={(e) => onMinPriceChange(e.target.value)}
          dir="ltr"
          className="px-3 py-2 rounded-lg border border-border bg-white text-sm w-28"
        />
        <input
          type="number"
          min={0}
          inputMode="numeric"
          placeholder={t.maxPrice}
          value={maxPrice}
          onChange={(e) => onMaxPriceChange(e.target.value)}
          dir="ltr"
          className="px-3 py-2 rounded-lg border border-border bg-white text-sm w-28"
        />
      </div>

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => onTagChange(null)}
            className={cn(
              "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
              selectedTag === null
                ? "bg-accent text-white"
                : "bg-white border border-border text-text-secondary hover:border-accent"
            )}
          >
            {t.allTags}
          </button>
          {tags.map((tag) => (
            <button
              key={tag}
              onClick={() => onTagChange(selectedTag === tag ? null : tag)}
              className={cn(
                "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                selectedTag === tag
                  ? "bg-accent text-white"
                  : "bg-white border border-border text-text-secondary hover:border-accent"
              )}
              dir="auto"
            >
              #{tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
