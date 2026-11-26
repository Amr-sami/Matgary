"use client";

import {
  Receipt,
  Wallet,
  AlertCircle,
  ShoppingBasket,
  TrendingDown,
} from "@/lib/icons";
import type { PurchaseOrderSummary } from "@/hooks/usePurchaseOrders";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";

interface PurchasesKpiCardsProps {
  orders: PurchaseOrderSummary[]; // already filtered
  rangeLabel: string;
}

export function PurchasesKpiCards({ orders, rangeLabel }: PurchasesKpiCardsProps) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.purchases.kpi;
  // Count POs that affect spend (drafts don't, cancelled don't).
  const active = orders.filter((o) => o.status === "received");
  const count = active.length;
  const totalPurchases = active.reduce((s, o) => s + o.total, 0);
  const totalPaid = active.reduce((s, o) => s + o.paidAmount, 0);
  const remaining = Math.max(0, totalPurchases - totalPaid);
  const avg = count > 0 ? totalPurchases / count : 0;

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <Card
        icon={<Receipt className="w-5 h-5" />}
        label={t.received.replace("{range}", rangeLabel)}
        value={String(count)}
      />
      <Card
        icon={<ShoppingBasket className="w-5 h-5" />}
        label={t.totalPurchases}
        value={formatCurrency(totalPurchases, locale)}
        tone="accent"
      />
      <Card
        icon={<Wallet className="w-5 h-5" />}
        label={t.paid}
        value={formatCurrency(totalPaid, locale)}
        tone="success"
      />
      <Card
        icon={<AlertCircle className="w-5 h-5" />}
        label={t.remaining}
        value={formatCurrency(remaining, locale)}
        tone={remaining > 0 ? "danger" : "default"}
      />
      <Card
        icon={<TrendingDown className="w-5 h-5" />}
        label={t.avg}
        value={formatCurrency(Math.round(avg), locale)}
      />
    </div>
  );
}

function Card({
  icon,
  label,
  value,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
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
  return (
    <div className="rounded-xl p-4 border border-border bg-white">
      <div className={`flex items-center gap-2 mb-1 ${iconClass}`}>
        {icon}
        <span className="text-xs text-text-secondary">{label}</span>
      </div>
      <p className="text-lg font-bold leading-tight">{value}</p>
    </div>
  );
}
