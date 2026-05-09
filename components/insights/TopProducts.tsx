"use client";

import { Tag } from "@/lib/icons";
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
  const maxRevenue = products.reduce(
    (max, p) => (p.revenue > max ? p.revenue : max),
    0,
  );

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-border overflow-hidden h-full flex flex-col">
      <div className="px-5 pt-5 pb-3 border-b border-border flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            أكثر المنتجات مبيعاً
          </h3>
          <p className="text-[11px] text-text-secondary mt-0.5">
            مرتبة حسب القيمة الإجمالية للمبيعات
          </p>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-text-secondary">
          أعلى 5
        </span>
      </div>

      {products.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <p className="text-sm text-text-secondary">
            لا توجد بيانات كافية حالياً
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {products.map((product, index) => {
            const widthPct =
              maxRevenue === 0 ? 0 : (product.revenue / maxRevenue) * 100;
            return (
              <li key={product.id} className="px-5 py-3.5">
                <div className="flex items-center gap-3">
                  <span className="w-6 h-6 rounded-md bg-bg-main text-text-secondary text-[11px] font-bold flex items-center justify-center shrink-0 border border-border">
                    {index + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-text-primary truncate">
                          {product.name}
                        </p>
                        {product.brand && (
                          <p className="text-[11px] text-text-secondary flex items-center gap-1 mt-0.5">
                            <Tag className="w-3 h-3 text-accent" />
                            {product.brand}
                          </p>
                        )}
                      </div>
                      <div className="text-left shrink-0">
                        <p className="text-sm font-semibold text-text-primary tabular-nums">
                          {formatPrice(product.revenue)}
                        </p>
                        <p className="text-[10px] text-text-secondary tabular-nums">
                          {product.qty} قطعة
                        </p>
                      </div>
                    </div>
                    <div className="h-1 bg-bg-main rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-full transition-all duration-500"
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
