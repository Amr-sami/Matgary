"use client";

import { Download, Printer, X } from "@/lib/icons";
import type { Sale } from "@/lib/types";

interface SalesBulkActionsProps {
  selected: Sale[];
  onClear: () => void;
  onExport: () => void;
  onPrintAll: () => void;
}

export function SalesBulkActions({ selected, onClear, onExport, onPrintAll }: SalesBulkActionsProps) {
  if (selected.length === 0) return null;
  return (
    <div className="sticky top-2 z-20 bg-accent text-white rounded-xl shadow-lg p-3 flex flex-wrap items-center gap-2">
      <span className="font-medium text-sm">
        {selected.length} فاتورة محددة
      </span>
      <div className="flex-1" />
      <button
        onClick={onPrintAll}
        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm"
      >
        <Printer className="w-4 h-4" />
        طباعة المحدد
      </button>
      <button
        onClick={onExport}
        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm"
      >
        <Download className="w-4 h-4" />
        تصدير CSV
      </button>
      <button
        onClick={onClear}
        className="p-1.5 rounded-lg hover:bg-white/10"
        title="إلغاء التحديد"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
