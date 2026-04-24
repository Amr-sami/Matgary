"use client";

import { useProducts } from "@/hooks/useProducts";
import { Badge } from "../ui/Badge";
import { CATEGORY_LABELS, GENDER_LABELS } from "@/lib/types";
import { AlertTriangle, CheckCircle } from "lucide-react";

export function LowStockAlert() {
  const { products, loading } = useProducts();

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
      <h3 className="font-semibold mb-4">تنبيهات المخزون</h3>

      {lowStockProducts.length === 0 ? (
        <div className="flex items-center gap-2 text-success">
          <CheckCircle className="w-5 h-5" />
          <span>المخزن بخير</span>
        </div>
      ) : (
        <div className="space-y-3">
          {outOfStock.slice(0, 3).map((product) => (
            <div
              key={product.id}
              className="flex items-center justify-between p-3 rounded-lg bg-danger-light/50 border border-danger/10"
            >
              <div>
                <p className="font-medium text-sm">{product.name}</p>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="outofstock">نفذ</Badge>
                  <span className="text-xs text-text-secondary">
                    {CATEGORY_LABELS[product.category]} •{" "}
                    {GENDER_LABELS[product.gender]}
                  </span>
                </div>
              </div>
              <AlertTriangle className="w-4 h-4 text-danger" />
            </div>
          ))}
          {lowStock.slice(0, 3).map((product) => (
            <div
              key={product.id}
              className="flex items-center justify-between p-3 rounded-lg bg-orange-50 border border-orange-100"
            >
              <div>
                <p className="font-medium text-sm">{product.name}</p>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="lowstock">{product.quantity} قطعة</Badge>
                  <span className="text-xs text-text-secondary">
                    {CATEGORY_LABELS[product.category]}
                  </span>
                </div>
              </div>
              <AlertTriangle className="w-4 h-4 text-orange-500" />
            </div>
          ))}
          {lowStockProducts.length > 6 && (
            <p className="text-xs text-text-secondary text-center">
              +{lowStockProducts.length - 6} منتج آخر
            </p>
          )}
        </div>
      )}
    </div>
  );
}