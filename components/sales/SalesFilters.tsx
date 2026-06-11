"use client";

import { cn } from "@/lib/utils";
import { CATEGORY_LABELS, GENDER_LABELS, type Category, type Gender } from "@/lib/types";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { FilterSelect, SortSelect } from "@/components/ui/FilterSelect";

export type DateRangeKey = "today" | "yesterday" | "7d" | "30d" | "thisMonth" | "all" | "custom";

/**
 * Kept for back-compat with components that haven't been rewired to use
 * `dict.app.dateRange` yet (e.g. Purchases). New code should pull labels
 * from the dictionary instead of this constant.
 */
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
  const dict = useDictionary();
  const t = dict.app.sales.filters;
  const dr = dict.app.dateRange;
  const dateRangeLabels: Record<DateRangeKey, string> = {
    today: dr.today,
    yesterday: dr.yesterday,
    "7d": dr["7d"],
    "30d": dr["30d"],
    thisMonth: dr.thisMonth,
    all: dr.all,
    custom: dr.custom,
  };
  const sortLabels: Record<SalesSortKey, string> = {
    newest: t.sort.newest,
    oldest: t.sort.oldest,
    totalDesc: t.sort.totalDesc,
    totalAsc: t.sort.totalAsc,
    qtyDesc: t.sort.qtyDesc,
    qtyAsc: t.sort.qtyAsc,
  };

  const categories: (Category | null)[] = [null, "watches", "perfumes", "sunglasses"];
  const genders: (Gender | null)[] = [null, "male", "female"];
  const statuses: { value: "all" | "sold" | "returned"; label: string }[] = [
    { value: "all", label: t.status.all },
    { value: "sold", label: t.status.sold },
    { value: "returned", label: t.status.returned },
  ];
  const ranges: DateRangeKey[] = ["today", "yesterday", "7d", "30d", "thisMonth", "all", "custom"];

  return (
    <div className="space-y-3 bg-white rounded-xl border border-border p-3">
      <input
        type="text"
        placeholder={t.searchPlaceholder}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
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
            {dateRangeLabels[r]}
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
            {cat ? CATEGORY_LABELS[cat] : t.allCategories}
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
            {g ? GENDER_LABELS[g] : t.allGenders}
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
          <FilterSelect
            value={selectedBrand}
            onChange={onBrandChange}
            allLabel={t.allBrands}
            options={brands}
          />
        )}

        <SortSelect
          value={sort}
          onChange={onSortChange}
          options={(Object.keys(sortLabels) as SalesSortKey[]).map((k) => ({
            value: k,
            label: sortLabels[k],
          }))}
          prefix={t.sortPrefix.replace("{label}", "")}
        />

        <label className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-white text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={discountOnly}
            onChange={(e) => onDiscountOnlyChange(e.target.checked)}
            className="w-4 h-4 accent-accent"
          />
          <span>{t.discountOnly}</span>
        </label>
      </div>
    </div>
  );
}
