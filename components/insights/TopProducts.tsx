"use client";

import { Tag } from "@/lib/icons";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";
import { UserText } from "@/components/ui/UserText";

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
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.insights.topProducts;
  const maxRevenue = products.reduce(
    (max, p) => (p.revenue > max ? p.revenue : max),
    0,
  );

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-border overflow-hidden h-full flex flex-col">
      <div className="px-5 pt-5 pb-3 border-b border-border flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            {t.title}
          </h3>
          <p className="text-[11px] text-text-secondary mt-0.5">
            {t.subtitle}
          </p>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-text-secondary">
          {t.top5}
        </span>
      </div>

      {products.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <p className="text-sm text-text-secondary">{t.empty}</p>
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
                        <UserText
                          as="p"
                          className="text-sm font-medium text-text-primary truncate"
                        >
                          {product.name}
                        </UserText>
                        {product.brand && (
                          <p className="text-[11px] text-text-secondary flex items-center gap-1 mt-0.5">
                            <Tag className="w-3 h-3 text-accent" />
                            <UserText>{product.brand}</UserText>
                          </p>
                        )}
                      </div>
                      <div className="text-end shrink-0">
                        <p className="text-sm font-semibold text-text-primary tabular-nums">
                          {formatCurrency(product.revenue, locale)}
                        </p>
                        <p className="text-[10px] text-text-secondary tabular-nums">
                          {t.pieces.replace("{n}", String(product.qty))}
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
