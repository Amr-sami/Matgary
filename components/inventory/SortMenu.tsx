"use client";

import { ArrowUpDown } from "@/lib/icons";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

export type SortKey =
  | "newest"
  | "oldest"
  | "name"
  | "priceAsc"
  | "priceDesc"
  | "qtyAsc"
  | "qtyDesc"
  | "marginAsc"
  | "marginDesc";

/**
 * Back-compat export for callers that haven't been migrated to use the dict.
 * New code should read from `dict.app.inventory.sort.options`.
 */
export const SORT_LABELS: Record<SortKey, string> = {
  newest: "الأحدث",
  oldest: "الأقدم",
  name: "الاسم (أ-ي)",
  priceAsc: "السعر (الأقل)",
  priceDesc: "السعر (الأعلى)",
  qtyAsc: "الكمية (الأقل)",
  qtyDesc: "الكمية (الأعلى)",
  marginAsc: "هامش الربح (الأقل)",
  marginDesc: "هامش الربح (الأعلى)",
};

interface SortMenuProps {
  value: SortKey;
  onChange: (value: SortKey) => void;
}

export function SortMenu({ value, onChange }: SortMenuProps) {
  const dict = useDictionary();
  const t = dict.app.inventory.sort;
  const order: SortKey[] = [
    "newest",
    "oldest",
    "name",
    "priceAsc",
    "priceDesc",
    "qtyAsc",
    "qtyDesc",
    "marginAsc",
    "marginDesc",
  ];
  return (
    <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-white text-sm cursor-pointer">
      <ArrowUpDown className="w-4 h-4 text-text-secondary" />
      <span className="text-text-secondary">{t.label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SortKey)}
        dir="auto"
        className="bg-transparent focus:outline-none cursor-pointer"
      >
        {order.map((k) => (
          <option key={k} value={k}>
            {t.options[k]}
          </option>
        ))}
      </select>
    </label>
  );
}
