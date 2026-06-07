"use client";

import { useMemo } from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { CATEGORY_LABELS, type Category } from "@/lib/types";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";

const PALETTE = ["#1203E3", "#5B4DEC", "#9C92F3", "#C7C0F8", "#1A1A1A"];

interface CategoryPieChartProps {
  data: { name: string; value: number }[];
}

export function CategoryPieChart({ data }: CategoryPieChartProps) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.insights.categoryPie;
  const { chartData, total } = useMemo(() => {
    const sorted = [...data].sort((a, b) => b.value - a.value);
    const total = sorted.reduce((s, d) => s + d.value, 0);
    return {
      total,
      chartData: sorted.map((item, idx) => ({
        ...item,
        displayName: CATEGORY_LABELS[item.name as Category] || item.name,
        color: PALETTE[idx % PALETTE.length],
        share: total === 0 ? 0 : (item.value / total) * 100,
      })),
    };
  }, [data]);

  const isEmpty = total === 0;

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-border overflow-hidden h-full flex flex-col">
      <div className="px-5 pt-5 pb-3 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary">{t.title}</h3>
        <p className="text-[11px] text-text-secondary mt-0.5">{t.subtitle}</p>
      </div>

      {isEmpty ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <p className="text-sm text-text-secondary">{t.empty}</p>
        </div>
      ) : (
        <>
          <div className="relative h-[180px] mt-2">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={56}
                  outerRadius={78}
                  paddingAngle={2}
                  dataKey="value"
                  nameKey="displayName"
                  stroke="none"
                >
                  {chartData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    borderRadius: "10px",
                    border: "1px solid #E8E4DC",
                    boxShadow: "0 8px 20px -8px rgb(0 0 0 / 0.18)",
                    fontFamily: "var(--font-cairo)",
                    fontSize: "12px",
                    padding: "8px 10px",
                  }}
                  formatter={(value) => [
                    formatCurrency(Number(value || 0), locale),
                    t.tooltipLabel,
                  ]}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <p className="text-[10px] uppercase tracking-wider text-text-secondary">
                {t.total}
              </p>
              <p className="text-sm font-semibold text-text-primary tabular-nums">
                {formatCurrency(total, locale)}
              </p>
            </div>
          </div>

          <ul className="px-4 pb-4 pt-1 space-y-2">
            {chartData.map((entry) => (
              <li
                key={entry.name}
                className="flex items-center gap-3 text-sm"
              >
                <span
                  className="w-2.5 h-2.5 rounded-sm shrink-0"
                  style={{ backgroundColor: entry.color }}
                  aria-hidden
                />
                <span
                  dir="auto"
                  className="flex-1 truncate text-text-primary"
                >
                  {entry.displayName}
                </span>
                <span className="text-text-secondary tabular-nums text-xs">
                  {entry.share.toFixed(1)}%
                </span>
                <span className="font-semibold text-text-primary tabular-nums w-24 text-end">
                  {formatCurrency(entry.value, locale)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
