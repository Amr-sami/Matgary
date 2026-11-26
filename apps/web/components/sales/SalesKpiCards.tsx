"use client";

import type { Sale } from "@/lib/types";
import { Receipt, Wallet, Percent, ShoppingBasket, TrendingUp } from "@/lib/icons";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency, formatPercent } from "@/lib/i18n/format";

interface SalesKpiCardsProps {
  sales: Sale[]; // already filtered by date range
  rangeLabel: string;
}

export function SalesKpiCards({ sales, rangeLabel }: SalesKpiCardsProps) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.sales.kpi;
  const active = sales.filter((s) => !s.isReturned);
  const invoices = active.length;
  const revenue = active.reduce((s, x) => s + x.totalPrice, 0);
  const grossSubtotal = active.reduce((s, x) => s + x.subtotal, 0);
  const totalDiscount = active.reduce((s, x) => s + (x.discountAmount || 0), 0);

  // Per-line profit: sale revenue minus per-unit cost × qty. Mirrors
  // lib/repo/insights.ts so the two screens never disagree. Lines that
  // were sold below cost (whether due to a discount or because someone
  // entered cost > price on the product) are counted toward `lossLines`
  // so the subtitle can point at the actual cause instead of just
  // saying "needs review".
  let profit = 0;
  let lossAmount = 0;
  let lossLines = 0;
  for (const x of active) {
    const cost = typeof x.costPriceAtSale === "number"
      ? x.costPriceAtSale * x.quantitySold
      : 0;
    const linePnL = x.totalPrice - cost;
    profit += linePnL;
    if (linePnL < 0) {
      lossLines += 1;
      lossAmount += linePnL;
    }
  }

  const avgBasket = invoices > 0 ? Math.round(revenue / invoices) : 0;
  const avgDiscountFraction =
    grossSubtotal > 0 ? totalDiscount / grossSubtotal : 0;

  const profitSubtitle =
    lossLines > 0
      ? t.profitLossHint
          .replace("{n}", String(lossLines))
          .replace("{amount}", formatCurrency(Math.abs(lossAmount), locale))
      : undefined;

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <Card
        icon={<Receipt className="w-5 h-5" />}
        label={t.invoicesInRange.replace("{range}", rangeLabel)}
        value={String(invoices)}
      />
      <Card
        icon={<Wallet className="w-5 h-5" />}
        label={t.netSales}
        value={formatCurrency(revenue, locale)}
        tone="accent"
      />
      <Card
        icon={<TrendingUp className="w-5 h-5" />}
        label={t.netProfit}
        value={formatCurrency(profit, locale)}
        tone={profit < 0 ? "danger" : "success"}
        subtitle={profitSubtitle}
      />
      <Card
        icon={<ShoppingBasket className="w-5 h-5" />}
        label={t.avgBasket}
        value={formatCurrency(avgBasket, locale)}
      />
      <Card
        icon={<Percent className="w-5 h-5" />}
        label={t.avgDiscount}
        value={formatPercent(avgDiscountFraction, locale)}
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
  tone?: "default" | "accent" | "success" | "danger";
}) {
  const iconClass =
    tone === "accent"
      ? "text-accent"
      : tone === "success"
        ? "text-success"
        : tone === "danger"
          ? "text-danger"
          : "text-text-secondary";
  const valueClass = tone === "danger" ? "text-danger" : "";
  return (
    <div className="rounded-xl p-4 border border-border bg-white">
      <div className={`flex items-center gap-2 mb-1 ${iconClass}`}>
        {icon}
        <span className="text-xs text-text-secondary">{label}</span>
      </div>
      <p className={`text-lg font-bold leading-tight ${valueClass}`}>{value}</p>
      {subtitle && (
        <p className={`text-[10px] mt-0.5 ${tone === "danger" ? "text-danger" : "text-orange-600"}`}>
          {subtitle}
        </p>
      )}
    </div>
  );
}
