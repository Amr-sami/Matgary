"use client";

import { Tag, TrendingUp } from "@/lib/icons";
import { formatPrice } from "@/lib/utils";

interface TopProduct {
  id: string;
  name: string;
  brand?: string;
  qty: number;
  revenue: number;
}

interface TopProductsProps {
  products: TopProduct[];
}

export function TopProducts({ products }: TopProductsProps) {
  return (
    <div className="bg-white rounded-xl p-5 shadow-sm border border-border">
      <div className="flex items-center justify-between mb-6">
        <h3 className="font-bold">أكثر المنتجات مبيعاً</h3>
        <div className="bg-success-light p-2 rounded-lg">
          <TrendingUp className="w-4 h-4 text-success" />
        </div>
      </div>

      <div className="space-y-5">
        {products.map((product, index) => (
          <div key={product.id} className="flex items-center gap-4">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-50 border border-border flex items-center justify-center text-xs font-bold text-text-secondary">
              {index + 1}
            </div>
            
            <div className="flex-1 min-w-0">
              <p className="font-semibold truncate">{product.name}</p>
              <p className="text-xs text-text-secondary flex items-center gap-1">
                <Tag className="w-3 h-3 text-accent" />
                {product.brand}
              </p>
            </div>

            <div className="text-right">
              <p className="font-bold text-accent">{formatPrice(product.revenue)}</p>
              <p className="text-[10px] text-text-secondary uppercase tracking-wider">
                {product.qty} قطعة
              </p>
            </div>
          </div>
        ))}

        {products.length === 0 && (
          <p className="text-center text-sm text-text-secondary py-4">
            لا توجد بيانات كافية حالياً
          </p>
        )}
      </div>
    </div>
  );
}
