"use client";

import type { Sale } from "@/lib/types";
import { SalesTableRow } from "./SalesTableRow";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface SalesTableProps {
  sales: Sale[];
  onReturn: (sale: Sale) => void;
  onPrint: (sale: Sale) => void;
  onEdit: (sale: Sale) => void;
  onVoid: (sale: Sale) => void;
  onCustomerClick?: (sale: Sale) => void;
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
  onCustomerClick,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
}: SalesTableProps) {
  const dict = useDictionary();
  const col = dict.app.sales.table.col;
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
            <th className="text-start pb-3 px-4 py-3">{col.date}</th>
            <th className="text-start pb-3 px-4 py-3">{col.product}</th>
            <th className="text-start pb-3 px-4 py-3">{col.category}</th>
            <th className="text-start pb-3 px-4 py-3">{col.brand}</th>
            <th className="text-start pb-3 px-4 py-3">{col.quantity}</th>
            <th className="text-start pb-3 px-4 py-3">{col.price}</th>
            <th className="text-start pb-3 px-4 py-3">{col.total}</th>
            <th className="text-start pb-3 px-4 py-3">{col.status}</th>
            <th className="text-start pb-3 px-4 py-3">{col.action}</th>
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
              onCustomerClick={onCustomerClick}
              selected={selectedIds.has(sale.id)}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
