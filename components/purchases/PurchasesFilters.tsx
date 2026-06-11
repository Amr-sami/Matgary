"use client";

import { cn } from "@/lib/utils";
import { type DateRangeKey } from "@/components/sales/SalesFilters";
import type { SupplierDescriptor } from "@/lib/types";
import type { PurchaseOrderStatus } from "@/hooks/usePurchaseOrders";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { FilterSelect } from "@/components/ui/FilterSelect";

export type PaymentStatusKey = "all" | "unpaid" | "partial" | "paid";

interface PurchasesFiltersProps {
  query: string;
  onQueryChange: (v: string) => void;

  dateRange: DateRangeKey;
  onDateRangeChange: (r: DateRangeKey) => void;
  customFrom: string;
  customTo: string;
  onCustomFromChange: (v: string) => void;
  onCustomToChange: (v: string) => void;

  selectedSupplier: string | null;
  onSupplierChange: (v: string | null) => void;
  suppliers: SupplierDescriptor[];

  selectedStatus: PurchaseOrderStatus | "all";
  onStatusChange: (v: PurchaseOrderStatus | "all") => void;

  paymentStatus: PaymentStatusKey;
  onPaymentStatusChange: (v: PaymentStatusKey) => void;
}

const RANGES: DateRangeKey[] = [
  "today",
  "yesterday",
  "7d",
  "30d",
  "thisMonth",
  "all",
  "custom",
];

const PAYMENTS: PaymentStatusKey[] = ["all", "unpaid", "partial", "paid"];

export function PurchasesFilters({
  query,
  onQueryChange,
  dateRange,
  onDateRangeChange,
  customFrom,
  customTo,
  onCustomFromChange,
  onCustomToChange,
  selectedSupplier,
  onSupplierChange,
  suppliers,
  selectedStatus,
  onStatusChange,
  paymentStatus,
  onPaymentStatusChange,
}: PurchasesFiltersProps) {
  const dict = useDictionary();
  const t = dict.app.purchases.filters;
  const dr = dict.app.dateRange;
  const rangeLabels: Record<DateRangeKey, string> = {
    today: dr.today,
    yesterday: dr.yesterday,
    "7d": dr["7d"],
    "30d": dr["30d"],
    thisMonth: dr.thisMonth,
    all: dr.all,
    custom: dr.custom,
  };
  const statuses: { value: PurchaseOrderStatus | "all"; label: string }[] = [
    { value: "all", label: t.all },
    { value: "draft", label: t.drafts },
    { value: "received", label: t.received },
    { value: "cancelled", label: t.cancelled },
  ];

  return (
    <div className="space-y-3 bg-white rounded-xl border border-border p-3">
      <input
        type="text"
        placeholder={t.searchPlaceholder}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        className="w-full px-4 py-2.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
      />

      {/* Date range */}
      <div className="flex flex-wrap gap-2">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => onDateRangeChange(r)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
              dateRange === r
                ? "bg-accent text-white"
                : "bg-white border border-border text-text-secondary hover:border-accent",
            )}
          >
            {rangeLabels[r]}
          </button>
        ))}
      </div>

      {dateRange === "custom" && (
        <div className="flex flex-wrap gap-2">
          <input
            type="date"
            value={customFrom}
            onChange={(e) => onCustomFromChange(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-border bg-white text-sm"
          />
          <input
            type="date"
            value={customTo}
            onChange={(e) => onCustomToChange(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-border bg-white text-sm"
          />
          {(customFrom || customTo) && (
            <button
              type="button"
              onClick={() => {
                onCustomFromChange("");
                onCustomToChange("");
              }}
              className="px-3 py-1.5 rounded-lg text-xs text-text-secondary hover:text-danger"
            >
              {t.clear}
            </button>
          )}
        </div>
      )}

      {/* Status */}
      <div className="flex flex-wrap gap-2">
        {statuses.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => onStatusChange(s.value)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
              selectedStatus === s.value
                ? "bg-accent text-white"
                : "bg-white border border-border text-text-secondary hover:border-accent",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Payment status + supplier */}
      <div className="flex flex-wrap gap-2 items-center">
        {PAYMENTS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPaymentStatusChange(p)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
              paymentStatus === p
                ? "bg-success text-white"
                : "bg-white border border-border text-text-secondary hover:border-success",
            )}
          >
            {t.paymentStatus[p]}
          </button>
        ))}

        {suppliers.length > 0 && (
          <FilterSelect
            value={selectedSupplier}
            onChange={onSupplierChange}
            allLabel={t.allSuppliers}
            options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
          />
        )}
      </div>
    </div>
  );
}
