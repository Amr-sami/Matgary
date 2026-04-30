"use client";

import type { Sale } from "@/lib/types";
import { SalesTableRow } from "./SalesTableRow";

interface SalesTableProps {
  sales: Sale[];
  onReturn: (sale: Sale) => void;
  onPrint: (sale: Sale) => void;
  onEdit: (sale: Sale) => void;
  onVoid: (sale: Sale) => void;
  selectedIds: Set<string>;
  onToggleSelect: (sale: Sale) => void;
  onToggleSelectAll: () => void;
}

export function SalesTable({
  sales,
  onReturn,
  onPrint,
  onEdit,
  onVoid,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
}: SalesTableProps) {
  const allSelected = sales.length > 0 && sales.every((s) => selectedIds.has(s.id));
  const someSelected = !allSelected && sales.some((s) => selectedIds.has(s.id));

  return (
    <div className="bg-white rounded-xl shadow-sm border border-border overflow-x-auto">
      <table className="w-full min-w-[900px]">
        <thead>
          <tr className="text-sm text-text-secondary border-b border-border bg-gray-50">
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
            <th className="text-start pb-3 px-4 py-3">التاريخ</th>
            <th className="text-start pb-3 px-4 py-3">المنتج</th>
            <th className="text-start pb-3 px-4 py-3">الصنف</th>
            <th className="text-start pb-3 px-4 py-3">البراند</th>
            <th className="text-start pb-3 px-4 py-3">الكمية</th>
            <th className="text-start pb-3 px-4 py-3">السعر</th>
            <th className="text-start pb-3 px-4 py-3">الإجمالي</th>
            <th className="text-start pb-3 px-4 py-3">الحالة</th>
            <th className="text-start pb-3 px-4 py-3">إجراء</th>
          </tr>
        </thead>
        <tbody>
          {sales.map((sale) => (
            <SalesTableRow
              key={sale.id}
              sale={sale}
              onReturn={onReturn}
              onPrint={onPrint}
              onEdit={onEdit}
              onVoid={onVoid}
              selected={selectedIds.has(sale.id)}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}