"use client";

import { useMemo } from "react";
import type { Sale } from "@/lib/types";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";

interface SalesChartProps {
  sales: Sale[];
  days?: number;
}

export function SalesChart({ sales, days = 30 }: SalesChartProps) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.sales.chart;

  const buckets = useMemo(() => {
    const tag = locale === "en" ? "en-EG" : "ar-EG";
    const fmt = new Intl.DateTimeFormat(tag, {
      numberingSystem: "latn",
      month: "short",
      day: "numeric",
    });
    const out: { label: string; date: Date; total: number }[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      out.push({
        label: fmt.format(d),
        date: d,
        total: 0,
      });
    }
    for (const s of sales) {
      if (s.isReturned) continue;
      const sd = new Date(s.saleDate);
      sd.setHours(0, 0, 0, 0);
      const idx = out.findIndex((b) => b.date.getTime() === sd.getTime());
      if (idx >= 0) out[idx].total += s.totalPrice;
    }
    return out;
  }, [sales, days, locale]);

  const max = Math.max(1, ...buckets.map((b) => b.total));
  const grandTotal = buckets.reduce((s, b) => s + b.total, 0);

  const lastWeekTotal = buckets.slice(-7).reduce((s, b) => s + b.total, 0);
  const prevWeekTotal = buckets.slice(-14, -7).reduce((s, b) => s + b.total, 0);
  const wow =
    prevWeekTotal > 0
      ? ((lastWeekTotal - prevWeekTotal) / prevWeekTotal) * 100
      : null;

  return (
    <div className="bg-white rounded-xl border border-border p-4">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div>
          <p className="text-sm text-text-secondary">
            {t.headline.replace("{days}", String(days))}
          </p>
          <p className="text-xl font-bold">{formatCurrency(grandTotal, locale)}</p>
        </div>
        <div className="flex flex-col items-end text-xs">
          <span className="text-text-secondary">{t.last7}</span>
          <span className="font-bold">{formatCurrency(lastWeekTotal, locale)}</span>
          {wow !== null && (
            <span className={wow >= 0 ? "text-success" : "text-danger"}>
              {t.wow
                .replace("{arrow}", wow >= 0 ? "↑" : "↓")
                .replace("{pct}", Math.abs(wow).toFixed(0))}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-end gap-1 h-32 overflow-x-auto" dir="ltr">
        {buckets.map((b, i) => {
          const h = (b.total / max) * 100;
          return (
            <div
              key={i}
              className="flex flex-col items-center gap-1 min-w-[14px] group"
              title={`${b.label}: ${formatCurrency(b.total, locale)}`}
            >
              <div
                className="w-3 bg-accent/30 group-hover:bg-accent rounded-t transition-colors"
                style={{ height: `${h}%`, minHeight: b.total > 0 ? "2px" : "0" }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-text-secondary mt-1" dir="ltr">
        <span>{buckets[0]?.label}</span>
        <span>{buckets[buckets.length - 1]?.label}</span>
      </div>
    </div>
  );
}
