"use client";

import type { Product } from "@/lib/types";
import { ProductTableRow } from "./ProductTableRow";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";

interface ProductTableProps {
  products: Product[];
  onEdit: (product: Product) => void;
  onDelete: (product: Product) => void;
  onSell: (product: Product) => void;
  onAdjustQty: (product: Product, delta: number) => void;
  onHistory: (product: Product) => void;
  density: "comfortable" | "compact";
  selectedIds: Set<string>;
  onToggleSelect: (product: Product) => void;
  onToggleSelectAll: () => void;
}

export function ProductTable({
  products,
  onEdit,
  onDelete,
  onSell,
  onAdjustQty,
  onHistory,
  density,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
}: ProductTableProps) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.inventory.table;
  const totalQty = products.reduce((s, p) => s + p.quantity, 0);
  const totalStockValue = products.reduce(
    (s, p) => s + p.quantity * (p.costPrice || 0),
    0
  );
  const totalRetailValue = products.reduce(
    (s, p) => s + p.quantity * p.price,
    0
  );

  const allSelected = products.length > 0 && products.every((p) => selectedIds.has(p.id));
  const someSelected = !allSelected && products.some((p) => selectedIds.has(p.id));

  return (
    <div className="bg-white rounded-xl shadow-sm border border-border overflow-x-auto max-h-[70vh] overflow-y-auto">
      <table className="w-full min-w-[1100px]">
        <thead className="sticky top-0 z-10 bg-gray-50 shadow-[0_1px_0_0_var(--border)]">
          <tr className="text-sm text-text-secondary border-b border-border">
            <th className="text-start pb-3 px-4 py-3 w-8">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                onChange={onToggleSelectAll}
                className="w-4 h-4 accent-accent cursor-pointer"
              />
            </th>
            <th className="text-start pb-3 px-4 py-3">{t.col.name}</th>
            <th className="text-start pb-3 px-4 py-3">{t.col.category}</th>
            <th className="text-start pb-3 px-4 py-3">{t.col.gender}</th>
            <th className="text-start pb-3 px-4 py-3">{t.col.brand}</th>
            <th className="text-start pb-3 px-4 py-3">{t.col.quantity}</th>
            <th className="text-start pb-3 px-4 py-3">{t.col.price}</th>
            <th className="text-start pb-3 px-4 py-3">{t.col.margin}</th>
            <th className="text-start pb-3 px-4 py-3">{t.col.stockValue}</th>
            <th className="text-start pb-3 px-4 py-3">{t.col.updatedAt}</th>
            <th className="text-start pb-3 px-4 py-3">{t.col.actions}</th>
          </tr>
        </thead>
        <tbody>
          {products.map((product) => (
            <ProductTableRow
              key={product.id}
              product={product}
              onEdit={onEdit}
              onDelete={onDelete}
              onSell={onSell}
              onAdjustQty={onAdjustQty}
              onHistory={onHistory}
              density={density}
              selected={selectedIds.has(product.id)}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </tbody>
        {products.length > 0 && (
          <tfoot className="bg-gray-50 border-t border-border font-medium text-sm">
            <tr>
              <td className="px-4 py-3" colSpan={5}>
                {t.footer.totalLabel.replace("{n}", String(products.length))}
              </td>
              <td className="px-4 py-3">{totalQty}</td>
              <td className="px-4 py-3" colSpan={2}>
                <span className="text-text-secondary">{t.footer.retailValueLabel}{" "}</span>
                {formatCurrency(totalRetailValue, locale)}
              </td>
              <td className="px-4 py-3">{formatCurrency(totalStockValue, locale)}</td>
              <td className="px-4 py-3" colSpan={2} />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
