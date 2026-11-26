"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { ReturnModal } from "./ReturnModal";
import { useSales } from "@/hooks/useSales";
import type { Sale } from "@/lib/types";
import { RotateCcw } from "@/lib/icons";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency, formatDate } from "@/lib/i18n/format";

interface RecordReturnFlowProps {
  /** Called after the return is persisted — the page refreshes its list. */
  onRecorded: () => void | Promise<void>;
  /** Called when POST /api/returns fails — the page shows an error toast. */
  onError?: (message: string) => void;
}

/**
 * "Record return" from `/returns`. The take-return form itself is the same
 * `ReturnModal` the sales page opens from an invoice row — this component
 * only adds the missing first step: picking which sale is being returned.
 */
export function RecordReturnFlow({ onRecorded, onError }: RecordReturnFlowProps) {
  const dict = useDictionary();
  const t = dict.app.returns;
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sale, setSale] = useState<Sale | null>(null);

  return (
    <>
      <Button onClick={() => setPickerOpen(true)} className="gap-2">
        <RotateCcw className="w-4 h-4" />
        {t.record}
      </Button>

      <Modal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={t.pickSale.title}
      >
        {/* Mounted only while open, so the 60-day sales list is fetched on
            click — not as a second waterfall step on every /returns visit. */}
        {pickerOpen && (
          <SalePicker
            onPick={(s) => {
              setSale(s);
              setPickerOpen(false);
            }}
          />
        )}
      </Modal>

      <ReturnModal
        isOpen={!!sale}
        onClose={() => setSale(null)}
        sale={sale}
        onSuccess={async () => {
          // The picker is unmounted by now, so invalidate the cached sales
          // queries directly (prefix match) instead of via its hook — the
          // next picker open, or /sales, refetches.
          await Promise.all([
            qc.invalidateQueries({ queryKey: ["sales"] }),
            onRecorded(),
          ]);
        }}
        onError={onError}
      />
    </>
  );
}

function SalePicker({ onPick }: { onPick: (sale: Sale) => void }) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.returns.pickSale;
  const { sales, loading } = useSales();
  const [query, setQuery] = useState("");

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (
      sales
        // Same guard the sales-page row uses to disable its Return action.
        .filter((s) => !s.isReturned)
        .filter((s) => {
          if (!q) return true;
          return (
            s.productName.toLowerCase().includes(q) ||
            (s.invoiceId ?? "").toLowerCase().includes(q) ||
            (s.customerName ?? "").toLowerCase().includes(q) ||
            (s.customerPhone ?? "").includes(q)
          );
        })
        .sort(
          (a, b) =>
            new Date(b.saleDate).getTime() - new Date(a.saleDate).getTime(),
        )
        .slice(0, 50)
    );
  }, [sales, query]);

  return (
    <div className="space-y-3">
      <Input
        autoFocus
        placeholder={t.search}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {loading ? (
        <p className="text-sm text-text-secondary py-6 text-center">
          {dict.app.common.loading}
        </p>
      ) : candidates.length === 0 ? (
        <p className="text-sm text-text-secondary py-6 text-center">
          {sales.length === 0 ? t.noSales : t.empty}
        </p>
      ) : (
        <ul className="max-h-[50vh] overflow-y-auto divide-y divide-border rounded-lg border border-border">
          {candidates.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onPick(s)}
                className="w-full min-h-[44px] text-start px-4 py-3 hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none transition-colors"
              >
                <div className="flex items-center justify-between gap-3">
                  <span
                    className="font-medium text-text-primary truncate"
                    dir="auto"
                  >
                    {s.productName}
                  </span>
                  <span className="text-sm font-bold text-text-primary shrink-0">
                    {formatCurrency(s.totalPrice, locale)}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-text-secondary">
                  <span>{formatDate(s.saleDate, locale)}</span>
                  <span>{t.qty.replace("{n}", String(s.quantitySold))}</span>
                  {s.customerName && <span dir="auto">{s.customerName}</span>}
                  {s.invoiceId && (
                    <span dir="ltr">#{s.invoiceId.slice(0, 8)}</span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
