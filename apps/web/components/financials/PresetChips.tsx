// Date-preset chip row for the Financials pages. Same visual language as
// the existing Insights filter chips. The parent controls state and the
// server receives it via the query string. Includes a `custom` chip +
// inline from/to date inputs that appear when selected.

"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import type { DatePresetKey } from "@/lib/finance/dates";

const ORDER: DatePresetKey[] = [
  "today",
  "yesterday",
  "this_week",
  "this_month",
  "last_month",
  "last_7_days",
  "last_30_days",
  "this_year",
  "custom",
];

interface Props {
  value: DatePresetKey;
  onChange: (next: DatePresetKey) => void;
  customFrom?: string;
  customTo?: string;
  onCustomChange?: (from: string, to: string) => void;
}

export function PresetChips({
  value,
  onChange,
  customFrom,
  customTo,
  onCustomChange,
}: Props) {
  const dict = useDictionary();
  const locale = useLocale();
  const labels = dict.app.financials.presets as Record<string, string>;
  const customLabel = locale === "ar" ? "مخصّص" : "Custom";

  // Local mirror so the inputs don't need a parent round-trip per keystroke.
  const [from, setFrom] = useState(customFrom ?? "");
  const [to, setTo] = useState(customTo ?? "");

  return (
    <div className="space-y-2">
      <div
        className="flex gap-2 overflow-x-auto lg:flex-wrap lg:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="radiogroup"
        aria-label="Date range"
      >
        {ORDER.map((key) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={value === key}
            onClick={() => onChange(key)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-sm border transition-colors whitespace-nowrap shrink-0 min-h-11 lg:min-h-0",
              value === key
                ? "bg-accent text-white border-accent"
                : "bg-white border-border text-text-secondary hover:border-accent",
            )}
          >
            {key === "custom" ? customLabel : labels[key] ?? key}
          </button>
        ))}
      </div>

      {value === "custom" && onCustomChange && (
        <div className="flex flex-wrap items-end gap-3 bg-white border border-border rounded-lg p-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">
              {locale === "ar" ? "من" : "From"}
            </label>
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                onCustomChange(e.target.value, to);
              }}
              className="px-3 py-1.5 rounded-md border border-border focus:outline-none focus:border-accent text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">
              {locale === "ar" ? "إلى" : "To"}
            </label>
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                onCustomChange(from, e.target.value);
              }}
              className="px-3 py-1.5 rounded-md border border-border focus:outline-none focus:border-accent text-sm"
            />
          </div>
        </div>
      )}
    </div>
  );
}
