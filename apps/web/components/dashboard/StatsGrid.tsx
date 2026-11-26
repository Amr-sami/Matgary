"use client";

import { DollarSign, Package, ShoppingCart, RotateCcw } from "@/lib/icons";
import { StatCard } from "./StatCard";
import { useProducts } from "@/hooks/useProducts";
import { useSales } from "@/hooks/useSales";
import { useReturns } from "@/hooks/useReturns";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";

export function StatsGrid() {
  const { products, loading: productsLoading } = useProducts();
  const { sales, loading: salesLoading } = useSales();
  const { returns, loading: returnsLoading } = useReturns();
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.dashboard.stats;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const todaySales = sales
    .filter((s) => new Date(s.saleDate) >= today)
    .reduce((sum, s) => sum + s.totalPrice, 0);

  const monthSales = sales
    .filter((s) => new Date(s.saleDate) >= thisMonth)
    .reduce((sum, s) => sum + s.totalPrice, 0);

  const monthReturns = returns.filter(
    (r) => new Date(r.returnDate) >= thisMonth
  ).length;

  if (productsLoading || salesLoading || returnsLoading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-white rounded-xl p-5 animate-pulse">
            <div className="h-4 bg-gray-200 rounded w-24 mb-3" />
            <div className="h-8 bg-gray-200 rounded w-16" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard
        title={t.todaySales}
        value={formatCurrency(todaySales, locale)}
        icon={DollarSign}
        color="success"
        href="/reports?range=today"
      />
      <StatCard
        title={t.itemCount}
        value={products.length}
        icon={Package}
        color="accent"
        href="/inventory"
      />
      <StatCard
        title={t.monthSales}
        value={formatCurrency(monthSales, locale)}
        icon={ShoppingCart}
        color="accent"
        href="/reports?range=this-month"
      />
      <StatCard
        title={t.monthReturns}
        value={monthReturns}
        subtitle={t.returnsSuffix}
        icon={RotateCcw}
        color="danger"
        href="/reports?range=returns-this-month"
      />
    </div>
  );
}