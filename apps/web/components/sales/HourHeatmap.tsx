"use client";

import { useMemo } from "react";
import type { Sale } from "@/lib/types";
import { Clock } from "@/lib/icons";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface HourHeatmapProps {
  sales: Sale[];
}

export function HourHeatmap({ sales }: HourHeatmapProps) {
  const dict = useDictionary();
  const t = dict.app.sales.heatmap;
  const hours = useMemo(() => {
    const out = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      count: 0,
      revenue: 0,
    }));
    for (const s of sales) {
      if (s.isReturned) continue;
      const h = new Date(s.saleDate).getHours();
      out[h].count += 1;
      out[h].revenue += s.totalPrice;
    }
    return out;
  }, [sales]);

  const max = Math.max(1, ...hours.map((h) => h.count));
  const peak = hours.reduce((best, h) => (h.count > best.count ? h : best), hours[0]);

  return (
    <div className="bg-white rounded-xl border border-border p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-1">
        <div className="flex items-center gap-2">
          <Clock className="w-5 h-5 text-accent" />
          <p className="font-medium">{t.title}</p>
        </div>
        {peak.count > 0 && (
          <p className="text-xs text-text-secondary">
            {t.peak
              .replace("{hour}", String(peak.hour))
              .replace("{n}", String(peak.count))}
          </p>
        )}
      </div>
      <div className="grid grid-cols-12 gap-0.5" dir="ltr">
        {hours.map((h) => {
          const intensity = h.count / max;
          const opacity = 0.1 + intensity * 0.9;
          return (
            <div
              key={h.hour}
              className="aspect-square rounded flex items-end justify-center text-[8px] text-text-secondary"
              style={{
                background: h.count > 0 ? `rgba(160, 130, 80, ${opacity})` : "#f3f4f6",
                color: intensity > 0.6 ? "white" : undefined,
              }}
              title={t.cellTitle
                .replace("{h}", String(h.hour))
                .replace("{n}", String(h.count))}
            >
              {h.hour}
            </div>
          );
        })}
      </div>
    </div>
  );
}
