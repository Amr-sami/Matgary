"use client";

import { useMemo } from "react";
import type { Sale } from "@/lib/types";
import { TrendingUp, TrendingDown, Minus } from "@/lib/icons";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";

interface DayCompareCardProps {
  sales: Sale[]; // entire sales list (not date-filtered)
}

export function DayCompareCard({ sales }: DayCompareCardProps) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.sales.dayCompare;
  const stats = useMemo(() => {
    const now = new Date();
    const startToday = new Date(now);
    startToday.setHours(0, 0, 0, 0);
    const endToday = new Date(now);
    endToday.setHours(23, 59, 59, 999);

    const startLast = new Date(startToday);
    startLast.setDate(startLast.getDate() - 7);
    const endLast = new Date(endToday);
    endLast.setDate(endLast.getDate() - 7);

    let today = 0;
    let lastWeek = 0;
    let todayCount = 0;
    let lastCount = 0;
    for (const s of sales) {
      if (s.isReturned) continue;
      const ts = s.saleDate.getTime();
      if (ts >= startToday.getTime() && ts <= endToday.getTime()) {
        today += s.totalPrice;
        todayCount += 1;
      } else if (ts >= startLast.getTime() && ts <= endLast.getTime()) {
        lastWeek += s.totalPrice;
        lastCount += 1;
      }
    }
    return { today, lastWeek, todayCount, lastCount };
  }, [sales]);

  const diff = stats.today - stats.lastWeek;
  const pct = stats.lastWeek > 0 ? (diff / stats.lastWeek) * 100 : null;
  const dayName = new Date().toLocaleDateString(
    locale === "en" ? "en-EG" : "ar-EG",
    { weekday: "long" } as Intl.DateTimeFormatOptions,
  );

  return (
    <div className="rounded-xl border border-border bg-white p-4">
      <p className="text-sm text-text-secondary mb-1">
        {t.header.replace(/\{day\}/g, dayName)}
      </p>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xl font-bold">{formatCurrency(stats.today, locale)}</p>
          <p className="text-xs text-text-secondary">
            {t.todayInvoices.replace("{n}", String(stats.todayCount))}
          </p>
        </div>
        <div className="text-end">
          <p className="text-sm text-text-secondary">{formatCurrency(stats.lastWeek, locale)}</p>
          <p className="text-[10px] text-text-secondary">
            {t.lastWeekInvoices.replace("{n}", String(stats.lastCount))}
          </p>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1 text-sm">
        {diff > 0 ? (
          <TrendingUp className="w-4 h-4 text-success" />
        ) : diff < 0 ? (
          <TrendingDown className="w-4 h-4 text-danger" />
        ) : (
          <Minus className="w-4 h-4 text-text-secondary" />
        )}
        <span
          className={
            diff > 0
              ? "text-success font-medium"
              : diff < 0
                ? "text-danger font-medium"
                : "text-text-secondary"
          }
        >
          {diff >= 0 ? "+" : ""}
          {formatCurrency(Math.abs(diff), locale)}
          {pct !== null && (
            <span className="ms-1 text-xs">
              ({pct >= 0 ? "+" : ""}
              {pct.toFixed(0)}%)
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
