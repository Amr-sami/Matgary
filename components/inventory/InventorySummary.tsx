"use client";

import type { Product } from "@/lib/types";
import { AlertTriangle, Package, PackageX, Wallet } from "@/lib/icons";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";

interface InventorySummaryProps {
  products: Product[];
  onFilterLow: () => void;
  onFilterOut: () => void;
}

export function InventorySummary({ products, onFilterLow, onFilterOut }: InventorySummaryProps) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.inventory.summary;
  const total = products.length;
  const outOfStock = products.filter((p) => p.quantity === 0).length;
  const lowStock = products.filter(
    (p) => p.quantity > 0 && p.quantity <= p.lowStockThreshold
  ).length;
  const stockValue = products.reduce(
    (sum, p) => sum + p.quantity * (p.costPrice || 0),
    0
  );

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Card icon={<Package className="w-5 h-5" />} label={t.totalProducts} value={String(total)} />
      <button
        type="button"
        onClick={onFilterLow}
        className="text-start"
        disabled={lowStock === 0}
      >
        <Card
          icon={<AlertTriangle className="w-5 h-5" />}
          label={t.lowStock}
          value={String(lowStock)}
          tone={lowStock > 0 ? "warning" : "default"}
          clickable={lowStock > 0}
        />
      </button>
      <button
        type="button"
        onClick={onFilterOut}
        className="text-start"
        disabled={outOfStock === 0}
      >
        <Card
          icon={<PackageX className="w-5 h-5" />}
          label={t.outOfStock}
          value={String(outOfStock)}
          tone={outOfStock > 0 ? "danger" : "default"}
          clickable={outOfStock > 0}
        />
      </button>
      <Card
        icon={<Wallet className="w-5 h-5" />}
        label={t.stockValue}
        value={formatCurrency(stockValue, locale)}
      />
    </div>
  );
}

function Card({
  icon,
  label,
  value,
  tone = "default",
  clickable = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "default" | "warning" | "danger";
  clickable?: boolean;
}) {
  const toneClass =
    tone === "warning"
      ? "border-orange-200 bg-orange-50"
      : tone === "danger"
        ? "border-danger/20 bg-danger-light/30"
        : "border-border bg-white";
  const iconClass =
    tone === "warning" ? "text-orange-500" : tone === "danger" ? "text-danger" : "text-accent";
  return (
    <div
      className={`rounded-xl p-4 border ${toneClass} ${clickable ? "hover:border-accent transition-colors" : ""}`}
    >
      <div className={`flex items-center gap-2 mb-1 ${iconClass}`}>
        {icon}
        <span className="text-xs text-text-secondary">{label}</span>
      </div>
      <p className="text-lg font-bold">{value}</p>
    </div>
  );
}
