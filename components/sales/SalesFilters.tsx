"use client";

import { cn } from "@/lib/utils";
import { CATEGORY_LABELS, GENDER_LABELS, type Category, type Gender } from "@/lib/types";

export type DateRangeKey = "today" | "yesterday" | "7d" | "30d" | "thisMonth" | "all" | "custom";

export const DATE_RANGE_LABELS: Record<DateRangeKey, string> = {
  today: "اليوم",
  yesterday: "أمس",
  "7d": "آخر 7 أيام",
  "30d": "آخر 30 يوم",
  thisMonth: "هذا الشهر",
  all: "الكل",
  custom: "مخصص",
};

export type SalesSortKey =
  | "newest"
  | "oldest"
  | "totalDesc"
  | "totalAsc"
  | "qtyDesc"
  | "qtyAsc";

export const SALES_SORT_LABELS: Record<SalesSortKey, string> = {
  newest: "الأحدث",
  oldest: "الأقدم",
  totalDesc: "الإجمالي (الأعلى)",
  totalAsc: "الإجمالي (الأقل)",
  qtyDesc: "الكمية (الأكثر)",
  qtyAsc: "الكمية (الأقل)",
};

interface SalesFiltersProps {
  selectedCategory: Category | null;
  onCategoryChange: (category: Category | null) => void;
  selectedGender: Gender | null;
  onGenderChange: (gender: Gender | null) => void;
  selectedStatus: "all" | "sold" | "returned";
  onStatusChange: (status: "all" | "sold" | "returned") => void;
  selectedBrand: string | null;
  onBrandChange: (brand: string | null) => void;
  brands: string[];
  dateRange: DateRangeKey;
  onDateRangeChange: (range: DateRangeKey) => void;
  customFrom: string;
  customTo: string;
  onCustomFromChange: (v: string) => void;
  onCustomToChange: (v: string) => void;
  discountOnly: boolean;
  onDiscountOnlyChange: (v: boolean) => void;
  sort: SalesSortKey;
  onSortChange: (s: SalesSortKey) => void;
  query: string;
  onQueryChange: (v: string) => void;
}

export function SalesFilters({
  selectedCategory,
  onCategoryChange,
  selectedGender,
  onGenderChange,
  selectedStatus,
  onStatusChange,
  selectedBrand,
  onBrandChange,
  brands,
  dateRange,
  onDateRangeChange,
  customFrom,
  customTo,
  onCustomFromChange,
  onCustomToChange,
  discountOnly,
  onDiscountOnlyChange,
  sort,
  onSortChange,
  query,
  onQueryChange,
}: SalesFiltersProps) {
  const categories: (Category | null)[] = [null, "watches", "perfumes", "sunglasses"];
  const genders: (Gender | null)[] = [null, "male", "female"];
  const statuses = [
    { value: "all", label: "الكل" },
    { value: "sold", label: "مباع" },
    { value: "returned", label: "مرتجع" },
  ] as const;
  const ranges: DateRangeKey[] = ["today", "yesterday", "7d", "30d", "thisMonth", "all", "custom"];

  return (
    <div className="space-y-3 bg-white rounded-xl border border-border p-3">
      <input
        type="text"
        placeholder="ابحث بالمنتج، البراند، أو ملاحظة..."
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        dir="rtl"
        className="w-full px-4 py-2.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
      />

      {/* Date range */}
      <div className="flex flex-wrap gap-2">
        {ranges.map((r) => (
          <button
            key={r}
            onClick={() => onDateRangeChange(r)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
              dateRange === r
                ? "bg-accent text-white"
                : "bg-white border border-border text-text-secondary hover:border-accent"
            )}
          >
            {DATE_RANGE_LABELS[r]}
          </button>
        ))}
      </div>

      {dateRange === "custom" && (
        <div className="flex flex-wrap gap-2">
          <input
            type="date"
            value={customFrom}
            onChange={(e) => onCustomFromChange(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-border bg-white text-sm"
          />
          <input
            type="date"
            value={customTo}
            onChange={(e) => onCustomToChange(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-border bg-white text-sm"
          />
        </div>
      )}

      {/* Category */}
      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => (
          <button
            key={cat ?? "all"}
            onClick={() => onCategoryChange(cat)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
              selectedCategory === cat
                ? "bg-accent text-white"
                : "bg-white border border-border text-text-secondary hover:border-accent"
            )}
          >
            {cat ? CATEGORY_LABELS[cat] : "كل الأصناف"}
          </button>
        ))}
      </div>

      {/* Gender */}
      <div className="flex flex-wrap gap-2">
        {genders.map((g) => (
          <button
            key={g ?? "all"}
            onClick={() => onGenderChange(g)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
              selectedGender === g
                ? "bg-accent text-white"
                : "bg-white border border-border text-text-secondary hover:border-accent"
            )}
          >
            {g ? GENDER_LABELS[g] : "الكل"}
          </button>
        ))}
      </div>

      {/* Status + brand + sort + discount-only */}
      <div className="flex flex-wrap gap-2 items-center">
        {statuses.map((s) => (
          <button
            key={s.value}
            onClick={() => onStatusChange(s.value)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
              selectedStatus === s.value
                ? "bg-success text-white"
                : "bg-white border border-border text-text-secondary hover:border-success"
            )}
          >
            {s.label}
          </button>
        ))}

        {brands.length > 0 && (
          <select
            value={selectedBrand || ""}
            onChange={(e) => onBrandChange(e.target.value || null)}
            dir="rtl"
            className="px-3 py-1.5 rounded-lg border border-border bg-white text-sm"
          >
            <option value="">كل البراندات</option>
            {brands.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        )}

        <select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SalesSortKey)}
          dir="rtl"
          className="px-3 py-1.5 rounded-lg border border-border bg-white text-sm"
        >
          {(Object.keys(SALES_SORT_LABELS) as SalesSortKey[]).map((k) => (
            <option key={k} value={k}>
              ترتيب: {SALES_SORT_LABELS[k]}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-white text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={discountOnly}
            onChange={(e) => onDiscountOnlyChange(e.target.checked)}
            className="w-4 h-4 accent-accent"
          />
          <span>بخصم فقط</span>
        </label>
      </div>
    </div>
  );
}
