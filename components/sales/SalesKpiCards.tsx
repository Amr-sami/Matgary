"use client";

import type { Sale } from "@/lib/types";
import { formatPrice } from "@/lib/utils";
import { Receipt, Wallet, Percent, ShoppingBasket, TrendingUp } from "@/lib/icons";

interface SalesKpiCardsProps {
  sales: Sale[]; // already filtered by date range
  rangeLabel: string;
}

export function SalesKpiCards({ sales, rangeLabel }: SalesKpiCardsProps) {
  const active = sales.filter((s) => !s.isReturned);
  const invoices = active.length;
  const revenue = active.reduce((s, x) => s + x.totalPrice, 0);
  const grossSubtotal = active.reduce((s, x) => s + x.subtotal, 0);
  const totalDiscount = active.reduce((s, x) => s + (x.discountAmount || 0), 0);
  const profit = active.reduce(
    (s, x) =>
      s +
      (x.totalPrice -
        (typeof x.costPriceAtSale === "number"
          ? x.costPriceAtSale * x.quantitySold
          : 0)),
    0
  );
  const avgBasket = invoices > 0 ? Math.round(revenue / invoices) : 0;
  const avgDiscount =
    grossSubtotal > 0 ? (totalDiscount / grossSubtotal) * 100 : 0;

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <Card icon={<Receipt className="w-5 h-5" />} label={`فواتير ${rangeLabel}`} value={String(invoices)} />
      <Card
        icon={<Wallet className="w-5 h-5" />}
        label="صافي المبيعات"
        value={formatPrice(revenue)}
        tone="accent"
      />
      <Card
        icon={<TrendingUp className="w-5 h-5" />}
        label="صافي الربح"
        value={formatPrice(Math.max(0, profit))}
        tone="success"
        subtitle={profit < 0 ? "يحتاج مراجعة" : undefined}
      />
      <Card
        icon={<ShoppingBasket className="w-5 h-5" />}
        label="متوسط الفاتورة"
        value={formatPrice(avgBasket)}
      />
      <Card
        icon={<Percent className="w-5 h-5" />}
        label="متوسط الخصم"
        value={`${avgDiscount.toFixed(1)}%`}
      />
    </div>
  );
}

function Card({
  icon,
  label,
  value,
  subtitle,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  subtitle?: string;
  tone?: "default" | "accent" | "success";
}) {
  const iconClass =
    tone === "accent"
      ? "text-accent"
      : tone === "success"
        ? "text-success"
        : "text-text-secondary";
  return (
    <div className="rounded-xl p-4 border border-border bg-white">
      <div className={`flex items-center gap-2 mb-1 ${iconClass}`}>
        {icon}
        <span className="text-xs text-text-secondary">{label}</span>
      </div>
      <p className="text-lg font-bold leading-tight">{value}</p>
      {subtitle && <p className="text-[10px] text-orange-600 mt-0.5">{subtitle}</p>}
    </div>
  );
}
