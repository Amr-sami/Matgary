"use client";

import type { Product } from "@/lib/types";
import { ProductTableRow } from "./ProductTableRow";
import { formatPrice } from "@/lib/utils";

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
            <th className="text-start pb-3 px-4 py-3">اسم المنتج</th>
            <th className="text-start pb-3 px-4 py-3">الصنف</th>
            <th className="text-start pb-3 px-4 py-3">الجنس</th>
            <th className="text-start pb-3 px-4 py-3">البراند</th>
            <th className="text-start pb-3 px-4 py-3">الكمية</th>
            <th className="text-start pb-3 px-4 py-3">السعر</th>
            <th className="text-start pb-3 px-4 py-3">هامش الربح</th>
            <th className="text-start pb-3 px-4 py-3">قيمة المخزن</th>
            <th className="text-start pb-3 px-4 py-3">آخر تحديث</th>
            <th className="text-start pb-3 px-4 py-3">الإجراءات</th>
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
                الإجمالي ({products.length} منتج)
              </td>
              <td className="px-4 py-3">{totalQty}</td>
              <td className="px-4 py-3" colSpan={2}>
                <span className="text-text-secondary">قيمة البيع: </span>
                {formatPrice(totalRetailValue)}
              </td>
              <td className="px-4 py-3">{formatPrice(totalStockValue)}</td>
              <td className="px-4 py-3" colSpan={2} />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
