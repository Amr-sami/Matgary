"use client";

import { ArrowUpDown } from "lucide-react";

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
  return (
    <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-white text-sm cursor-pointer">
      <ArrowUpDown className="w-4 h-4 text-text-secondary" />
      <span className="text-text-secondary">ترتيب:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SortKey)}
        dir="rtl"
        className="bg-transparent focus:outline-none cursor-pointer"
      >
        {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
          <option key={k} value={k}>
            {SORT_LABELS[k]}
          </option>
        ))}
      </select>
    </label>
  );
}
