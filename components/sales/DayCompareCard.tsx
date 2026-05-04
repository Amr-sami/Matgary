"use client";

import { useMemo } from "react";
import type { Sale } from "@/lib/types";
import { formatPrice } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus } from "@/lib/icons";

interface DayCompareCardProps {
  sales: Sale[]; // entire sales list (not date-filtered)
}

export function DayCompareCard({ sales }: DayCompareCardProps) {
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
      const t = s.saleDate.getTime();
      if (t >= startToday.getTime() && t <= endToday.getTime()) {
        today += s.totalPrice;
        todayCount += 1;
      } else if (t >= startLast.getTime() && t <= endLast.getTime()) {
        lastWeek += s.totalPrice;
        lastCount += 1;
      }
    }
    return { today, lastWeek, todayCount, lastCount };
  }, [sales]);

  const diff = stats.today - stats.lastWeek;
  const pct = stats.lastWeek > 0 ? (diff / stats.lastWeek) * 100 : null;
  const dayName = new Date().toLocaleDateString("ar-EG", { weekday: "long" });

  return (
    <div className="rounded-xl border border-border bg-white p-4">
      <p className="text-sm text-text-secondary mb-1">
        مقارنة يوم {dayName} الحالي بـ {dayName} الماضي
      </p>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xl font-bold">{formatPrice(stats.today)}</p>
          <p className="text-xs text-text-secondary">{stats.todayCount} فاتورة اليوم</p>
        </div>
        <div className="text-end">
          <p className="text-sm text-text-secondary">{formatPrice(stats.lastWeek)}</p>
          <p className="text-[10px] text-text-secondary">
            {stats.lastCount} فاتورة الأسبوع الماضي
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
          {formatPrice(Math.abs(diff))}
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
