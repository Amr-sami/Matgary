"use client";

import { RotateCcw, Printer, Calendar, Tag, Pencil, Trash2 } from "@/lib/icons";
import { ShareReceiptButton } from "./ShareReceiptButton";
import type { Sale } from "@/lib/types";
import { Badge } from "../ui/Badge";
import { CATEGORY_LABELS } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency, formatDate, formatTime } from "@/lib/i18n/format";

interface SaleCardProps {
  sale: Sale;
  onReturn: (sale: Sale) => void;
  onPrint: (sale: Sale) => void;
  onEdit: (sale: Sale) => void;
  onVoid: (sale: Sale) => void;
  onCustomerClick?: (sale: Sale) => void;
  selected: boolean;
  onToggleSelect: (sale: Sale) => void;
}

export function SaleCard({
  sale,
  onReturn,
  onPrint,
  onEdit,
  onVoid,
  onCustomerClick,
  selected,
  onToggleSelect,
}: SaleCardProps) {
  const dict = useDictionary();
  const locale = useLocale();
  const tCard = dict.app.sales.card;
  const tTable = dict.app.sales.table;
  const status = dict.app.sales.status;
  const saleDate = new Date(sale.saleDate);
  const discountLabel =
    sale.discountAmount && sale.discountAmount > 0
      ? sale.discountType === "percentage"
        ? `${sale.discountValue}%`
        : formatCurrency(sale.discountAmount, locale)
      : null;

  return (
    <div
      className={cn(
        "bg-white rounded-xl p-4 shadow-sm border border-border transition-all font-cairo",
        selected && "ring-2 ring-accent",
        sale.isReturned && "opacity-75 bg-gray-50/50"
      )}
    >
      <div className="flex items-start justify-between mb-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(sale)}
          className="mt-1 w-4 h-4 accent-accent cursor-pointer"
        />
        <div className="flex-1 ms-2 space-y-1">
          <div className="flex flex-col gap-0.5 text-xs text-text-secondary">
            <div className="flex items-center gap-1.5 font-bold text-text-primary">
              <Calendar className="w-3.5 h-3.5 text-accent" />
              {formatDate(saleDate, locale)}
            </div>
            <span className="mr-5 opacity-70">
              {formatTime(saleDate, locale)}
            </span>
          </div>
          <h3 className="font-bold text-lg leading-tight mt-1" dir="auto">
            {sale.productName}
          </h3>
          {sale.brand && (
            <p className="text-sm text-text-secondary flex items-center gap-1" dir="auto">
              <Tag className="w-3.5 h-3.5 text-accent" />
              {sale.brand}
            </p>
          )}
          <div className="flex flex-wrap gap-1 mt-1">
            {sale.customerName && (
              <button
                type="button"
                onClick={() => onCustomerClick?.(sale)}
                className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-text-secondary hover:bg-accent hover:text-white transition-colors"
                title={tTable.rowCustomerTooltip}
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
        <div className="flex flex-col items-end gap-2">
          {sale.isReturned ? (
            <Badge variant="returned">{status.returned}</Badge>
          ) : (
            <Badge variant="sold">{status.sold}</Badge>
          )}
          <Badge variant={sale.category}>{CATEGORY_LABELS[sale.category]}</Badge>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4 p-3 bg-gray-50 rounded-lg border border-gray-100">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-text-secondary mb-0.5">{tCard.soldQty}</p>
          <p className="text-lg font-black leading-none">
            {tCard.qtyPieces.replace("{n}", String(sale.quantitySold))}
          </p>
        </div>
        <div className="text-end">
          <p className="text-[10px] uppercase tracking-wider text-text-secondary mb-0.5">{tCard.unitPrice}</p>
          <p className="text-lg font-black leading-none">{formatCurrency(sale.pricePerUnit, locale)}</p>
        </div>
      </div>

      {/* Discount Info */}
      {discountLabel && (
        <div className="flex items-center justify-between mb-3 px-1">
          <span className="text-xs text-danger font-bold">
            {tTable.discountAmount.replace("{value}", discountLabel)}
          </span>
          <span className="text-xs text-text-secondary line-through opacity-60 italic">
            {formatCurrency(sale.subtotal, locale)}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between pt-2 border-t border-gray-100">
        <div>
          <p className="text-xs text-text-secondary mb-0.5 font-medium">{tCard.totalLabel}</p>
          <p className="text-2xl font-black text-accent">{formatCurrency(sale.totalPrice, locale)}</p>
        </div>

        <div className="flex flex-col gap-2">
          {!sale.isReturned && (
            <button
              onClick={() => onPrint(sale)}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent/90 font-bold shadow-lg shadow-accent/20 border border-accent/20 text-sm"
            >
              <Printer className="w-4 h-4" />
              {tTable.actions.print}
            </button>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => onEdit(sale)}
              disabled={sale.isReturned}
              className="flex-1 flex items-center justify-center gap-1 px-3 py-2 bg-gray-100 text-text-secondary rounded-xl hover:bg-gray-200 disabled:opacity-40 text-sm"
            >
              <Pencil className="w-4 h-4" />
              {tTable.actions.edit}
            </button>
            <button
              onClick={() => onReturn(sale)}
              disabled={sale.isReturned}
              className={cn(
                "flex-1 flex items-center justify-center gap-1 px-3 py-2 rounded-xl text-sm",
                sale.isReturned
                  ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                  : "bg-danger-light text-danger hover:bg-danger hover:text-white border border-danger/10"
              )}
            >
              <RotateCcw className="w-4 h-4" />
              {tTable.actions.return}
            </button>
          </div>
          {!sale.isReturned && (
            <div className="flex">
              <ShareReceiptButton sale={sale} variant="row" />
            </div>
          )}
          <button
            onClick={() => onVoid(sale)}
            className="flex items-center justify-center gap-1 px-3 py-1.5 text-xs text-text-secondary hover:text-danger"
            title={tCard.voidTooltip}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {tCard.voidLong}
          </button>
        </div>
      </div>
    </div>
  );
}
