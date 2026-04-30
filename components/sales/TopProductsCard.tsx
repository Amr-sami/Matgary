"use client";

import { useMemo } from "react";
import type { Sale } from "@/lib/types";
import { formatPrice } from "@/lib/utils";
import { Trophy } from "lucide-react";

interface TopProductsCardProps {
  sales: Sale[];
  limit?: number;
}

export function TopProductsCard({ sales, limit = 5 }: TopProductsCardProps) {
  const top = useMemo(() => {
    const map = new Map<
      string,
      { name: string; brand?: string; qty: number; revenue: number }
    >();
    for (const s of sales) {
      if (s.isReturned) continue;
      const key = s.productId;
      const cur = map.get(key) || { name: s.productName, brand: s.brand, qty: 0, revenue: 0 };
      cur.qty += s.quantitySold;
      cur.revenue += s.totalPrice;
      map.set(key, cur);
    }
    return Array.from(map.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);
  }, [sales, limit]);

  return (
    <div className="bg-white rounded-xl border border-border p-4">
      <div className="flex items-center gap-2 mb-3">
        <Trophy className="w-5 h-5 text-accent" />
        <p className="font-medium">الأعلى مبيعاً</p>
      </div>
      {top.length === 0 ? (
        <p className="text-sm text-text-secondary">لا توجد بيانات</p>
      ) : (
        <ul className="space-y-2">
          {top.map((t, idx) => (
            <li
              key={idx}
              className="flex items-center justify-between text-sm gap-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-5 h-5 rounded-full bg-accent-light text-accent text-xs flex items-center justify-center font-bold shrink-0">
                  {idx + 1}
                </span>
                <span className="truncate">{t.name}</span>
              </div>
              <div className="text-end shrink-0">
                <p className="font-bold text-sm">{formatPrice(t.revenue)}</p>
                <p className="text-[10px] text-text-secondary">{t.qty} قطعة</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
