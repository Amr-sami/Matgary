"use client";

import { ArrowUpDown } from "@/lib/icons";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { SortSelect } from "@/components/ui/FilterSelect";

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

const ORDER: SortKey[] = [
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

interface SortMenuProps {
  value: SortKey;
  onChange: (value: SortKey) => void;
}

export function SortMenu({ value, onChange }: SortMenuProps) {
  const dict = useDictionary();
  const t = dict.app.inventory.sort;
  return (
    <SortSelect<SortKey>
      value={value}
      onChange={onChange}
      options={ORDER.map((k) => ({ value: k, label: t.options[k] }))}
      prefix={`${t.label}: `}
      leadingIcon={<ArrowUpDown className="w-4 h-4" />}
      ariaLabel={t.label}
    />
  );
}
