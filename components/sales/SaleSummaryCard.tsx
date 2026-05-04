"use client";

import { DollarSign } from "@/lib/icons";
import { useSales } from "@/hooks/useSales";
import { formatPrice } from "@/lib/utils";

export function SaleSummaryCard() {
  const { sales } = useSales();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todaySales = sales
    .filter((s) => new Date(s.saleDate) >= today && !s.isReturned)
    .reduce((sum, s) => sum + s.totalPrice, 0);

  return (
    <div className="bg-white rounded-xl p-5 shadow-sm border border-border">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-text-secondary">مبيعات اليوم</p>
          <p className="text-2xl font-bold text-success mt-1">
            {formatPrice(todaySales)}
          </p>
        </div>
        <div className="p-3 bg-success-light rounded-lg">
          <DollarSign className="w-6 h-6 text-success" />
        </div>
      </div>
    </div>
  );
}