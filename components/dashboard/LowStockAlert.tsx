"use client";

import { useProducts } from "@/hooks/useProducts";
import { Badge } from "../ui/Badge";
import { UserText } from "../ui/UserText";
import { CATEGORY_LABELS, GENDER_LABELS } from "@/lib/types";
import { AlertTriangle, CheckCircle } from "@/lib/icons";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

export function LowStockAlert() {
  const { products, loading } = useProducts();
  const dict = useDictionary();
  const t = dict.app.dashboard.lowStock;

  if (loading) {
    return (
      <div className="bg-white rounded-xl p-5 shadow-sm border border-border">
        <div className="animate-pulse">
          <div className="h-5 bg-gray-200 rounded w-32 mb-4" />
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-100 rounded" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const lowStockProducts = products.filter(
    (p) => p.quantity <= p.lowStockThreshold
  );

  const outOfStock = products.filter((p) => p.quantity === 0);
  const lowStock = products.filter(
    (p) => p.quantity > 0 && p.quantity <= p.lowStockThreshold
  );

  return (
    <div className="bg-white rounded-xl p-5 shadow-sm border border-border">
      <h3 className="font-semibold mb-4">{t.title}</h3>

      {lowStockProducts.length === 0 ? (
        <div className="flex items-center gap-2 text-success">
          <CheckCircle className="w-5 h-5" />
          <span>{t.allGood}</span>
        </div>
      ) : (
        // Scrollable list: out-of-stock first (more urgent), low-stock
        // below. Capped height keeps the dashboard tile a predictable
        // size even when the catalogue has dozens of alerts; the owner
        // scrolls inside the tile to see them all instead of having
        // the page stretch indefinitely.
        <div className="space-y-3 max-h-[360px] overflow-y-auto pe-1 [scrollbar-width:thin]">
          {outOfStock.map((product) => (
            <div
              key={product.id}
              className="flex items-center justify-between p-3 rounded-lg bg-danger-light/50 border border-danger/10"
            >
              <div>
                <UserText as="p" className="font-medium text-sm">
                  {product.name}
                </UserText>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="outofstock">{t.outOfStock}</Badge>
                  <UserText className="text-xs text-text-secondary">
                    {CATEGORY_LABELS[product.category]} •{" "}
                    {GENDER_LABELS[product.gender]}
                  </UserText>
                </div>
              </div>
              <AlertTriangle className="w-4 h-4 text-danger shrink-0" />
            </div>
          ))}
          {lowStock.map((product) => (
            <div
              key={product.id}
              className="flex items-center justify-between p-3 rounded-lg bg-orange-50 border border-orange-100"
            >
              <div>
                <UserText as="p" className="font-medium text-sm">
                  {product.name}
                </UserText>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="lowstock">
                    {t.pieces.replace("{n}", String(product.quantity))}
                  </Badge>
                  <UserText className="text-xs text-text-secondary">
                    {CATEGORY_LABELS[product.category]}
                  </UserText>
                </div>
              </div>
              <AlertTriangle className="w-4 h-4 text-orange-500 shrink-0" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}