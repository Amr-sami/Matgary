"use client";

import { RotateCcw, Printer, Pencil, Trash2 } from "@/lib/icons";
import { ShareReceiptButton } from "./ShareReceiptButton";
import type { Sale } from "@/lib/types";
import { Badge } from "../ui/Badge";
import { CATEGORY_LABELS } from "@/lib/types";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency, formatDate, formatTime } from "@/lib/i18n/format";

interface SalesTableRowProps {
  sale: Sale;
  onReturn: (sale: Sale) => void;
  onPrint: (sale: Sale) => void;
  onEdit: (sale: Sale) => void;
  onVoid: (sale: Sale) => void;
  onCustomerClick?: (sale: Sale) => void;
  selected: boolean;
  onToggleSelect: (sale: Sale) => void;
}

export function SalesTableRow({
  sale,
  onReturn,
  onPrint,
  onEdit,
  onVoid,
  onCustomerClick,
  selected,
  onToggleSelect,
}: SalesTableRowProps) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.sales.table;
  const status = dict.app.sales.status;
  const saleDate = new Date(sale.saleDate);
  const discountLabel =
    sale.discountAmount && sale.discountAmount > 0
      ? sale.discountType === "percentage"
        ? `${sale.discountValue}%`
        : formatCurrency(sale.discountAmount, locale)
      : null;

  return (
    <tr
      className={`border-b border-border last:border-0 hover:bg-gray-50/50 transition-colors font-cairo ${
        selected ? "bg-accent-light/30" : ""
      }`}
    >
      <td className="py-4 px-4 w-8">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(sale)}
          className="w-4 h-4 accent-accent cursor-pointer"
        />
      </td>
      <td className="py-4 px-4 text-sm">
        <div className="flex flex-col gap-0.5">
          <span className="font-bold text-text-primary whitespace-nowrap">
            {formatDate(saleDate, locale)}
          </span>
          <span className="text-xs text-text-secondary opacity-80">
            {formatTime(saleDate, locale)}
          </span>
        </div>
      </td>
      <td className="py-4 px-4 font-medium">
        <div>
          <span dir="auto">{sale.productName}</span>
          <div className="flex flex-wrap gap-1 mt-0.5">
            {sale.customerName && (
              <button
                type="button"
                onClick={() => onCustomerClick?.(sale)}
                className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-text-secondary hover:bg-accent hover:text-white transition-colors"
                title={t.rowCustomerTooltip}
                dir="auto"
              >
                {sale.customerName}
              </button>
            )}
            {sale.paymentMethod && (
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                  sale.paymentMethod === "deferred" && !sale.isPaid
                    ? "bg-orange-100 text-orange-700"
                    : sale.paymentMethod === "deferred" && sale.isPaid
                      ? "bg-success-light text-success"
                      : "bg-accent-light text-accent"
                }`}
              >
                {dict.app.catalog.payment[sale.paymentMethod]}
                {sale.paymentMethod === "deferred" && (sale.isPaid ? " ✓" : "")}
              </span>
            )}
          </div>
        </div>
      </td>
      <td className="py-4 px-4">
        <Badge variant={sale.category}>{CATEGORY_LABELS[sale.category]}</Badge>
      </td>
      <td className="py-4 px-4 text-sm text-text-secondary" dir="auto">{sale.brand || "-"}</td>
      <td className="py-4 px-4 text-center font-semibold">{sale.quantitySold}</td>
      <td className="py-4 px-4 text-sm font-medium">{formatCurrency(sale.pricePerUnit, locale)}</td>
      <td className="py-4 px-4">
        <div className="flex flex-col">
          <span className="font-bold text-accent">{formatCurrency(sale.totalPrice, locale)}</span>
          {discountLabel && (
            <div className="flex flex-col text-[10px] items-start mt-0.5">
              <span className="text-text-secondary line-through italic opacity-60">
                {formatCurrency(sale.subtotal, locale)}
              </span>
              <span className="text-danger font-bold">
                {t.discountAmount.replace("{value}", discountLabel)}
              </span>
            </div>
          )}
        </div>
      </td>
      <td className="py-4 px-4">
        {sale.isReturned ? (
          <Badge variant="returned">{status.returned}</Badge>
        ) : (
          <Badge variant="sold">{status.sold}</Badge>
        )}
      </td>
      <td className="py-4 px-4">
        <div className="flex items-center gap-2">
          {!sale.isReturned && (
            <button
              onClick={() => onPrint(sale)}
              className="p-1.5 rounded-lg text-accent hover:opacity-70 transition-opacity"
              title={t.actions.print}
            >
              <Printer className="w-4 h-4" />
            </button>
          )}
          {!sale.isReturned && <ShareReceiptButton sale={sale} />}
          <button
            onClick={() => onEdit(sale)}
            disabled={sale.isReturned}
            className="p-1.5 rounded-lg text-text-secondary hover:opacity-70 disabled:opacity-30 transition-opacity"
            title={t.actions.edit}
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            onClick={() => onReturn(sale)}
            disabled={sale.isReturned}
            className="p-1.5 rounded-lg text-danger hover:opacity-70 disabled:opacity-30 transition-opacity"
            title={t.actions.return}
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <button
            onClick={() => onVoid(sale)}
            className="p-1.5 rounded-lg text-text-secondary hover:text-danger hover:opacity-90 transition-colors"
            title={t.actions.void}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}
