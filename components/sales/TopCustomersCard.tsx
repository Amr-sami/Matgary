"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Users, Star } from "@/lib/icons";
import type { Sale } from "@/lib/types";
import { formatPrice } from "@/lib/utils";
import { buildCustomerAggregates } from "@/lib/customers";

interface TopCustomersCardProps {
  sales: Sale[];
  limit?: number;
}

export function TopCustomersCard({ sales, limit = 5 }: TopCustomersCardProps) {
  const top = useMemo(() => {
    const customers = buildCustomerAggregates(sales);
    return customers
      .sort((a, b) => b.lifetimeValue - a.lifetimeValue)
      .slice(0, limit);
  }, [sales, limit]);

  if (top.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-accent" />
          <p className="font-medium">أعلى العملاء إنفاقاً</p>
        </div>
        <Link
          href="/customers"
          className="text-xs text-accent hover:underline"
        >
          عرض الكل
        </Link>
      </div>
      <ul className="space-y-2">
        {top.map((c, idx) => (
          <li key={c.key} className="flex items-center justify-between text-sm gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-5 h-5 rounded-full bg-accent-light text-accent text-xs flex items-center justify-center font-bold shrink-0">
                {idx + 1}
              </span>
              <span className="truncate">{c.name}</span>
              {c.invoiceCount >= 3 && (
                <Star className="w-3 h-3 text-accent shrink-0" />
              )}
            </div>
            <div className="text-end shrink-0">
              <p className="font-bold text-sm">{formatPrice(c.lifetimeValue)}</p>
              <p className="text-[10px] text-text-secondary">
                {c.invoiceCount} فاتورة
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
