"use client";

import { cn } from "@/lib/utils";
import { CATEGORY_LABELS, GENDER_LABELS, type Category, type Gender } from "@/lib/types";

export type StockStatus = "in" | "low" | "out";

export const STOCK_STATUS_LABELS: Record<StockStatus, string> = {
  in: "متوفر",
  low: "مخزون منخفض",
  out: "نفذ",
};

interface InventoryFiltersProps {
  selectedCategory: Category | null;
  onCategoryChange: (category: Category | null) => void;
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
  selectedCategory,
  onCategoryChange,
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
  const categories: (Category | null)[] = [null, "watches", "perfumes", "sunglasses"];
  const genders: (Gender | null)[] = [null, "male", "female"];
  const stockStatuses: (StockStatus | null)[] = [null, "in", "low", "out"];

  return (
    <div className="space-y-3">
      {/* Category Filter */}
      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => (
          <button
            key={cat ?? "all"}
            onClick={() => onCategoryChange(cat)}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
              selectedCategory === cat
                ? "bg-accent text-white"
                : "bg-white border border-border text-text-secondary hover:border-accent"
            )}
          >
            {cat ? CATEGORY_LABELS[cat] : "كل الأصناف"}
          </button>
        ))}
      </div>

      {/* Gender Filter */}
      <div className="flex flex-wrap gap-2">
        {genders.map((g) => (
          <button
            key={g ?? "all"}
            onClick={() => onGenderChange(g)}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
              selectedGender === g
                ? "bg-accent text-white"
                : "bg-white border border-border text-text-secondary hover:border-accent"
            )}
          >
            {g ? GENDER_LABELS[g] : "الكل"}
          </button>
        ))}
      </div>

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
            {s ? STOCK_STATUS_LABELS[s] : "كل الحالات"}
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
            dir="rtl"
          >
            <option value="">كل البراندات</option>
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
            dir="rtl"
          >
            <option value="">كل الموردين</option>
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
          placeholder="أقل سعر"
          value={minPrice}
          onChange={(e) => onMinPriceChange(e.target.value)}
          dir="rtl"
          className="px-3 py-2 rounded-lg border border-border bg-white text-sm w-28"
        />
        <input
          type="number"
          min={0}
          inputMode="numeric"
          placeholder="أعلى سعر"
          value={maxPrice}
          onChange={(e) => onMaxPriceChange(e.target.value)}
          dir="rtl"
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
            كل التاجات
          </button>
          {tags.map((t) => (
            <button
              key={t}
              onClick={() => onTagChange(selectedTag === t ? null : t)}
              className={cn(
                "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                selectedTag === t
                  ? "bg-accent text-white"
                  : "bg-white border border-border text-text-secondary hover:border-accent"
              )}
            >
              #{t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}