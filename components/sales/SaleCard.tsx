"use client";

import { RotateCcw, Printer, Calendar, Tag, Pencil, Trash2 } from "@/lib/icons";
import { ShareReceiptButton } from "./ShareReceiptButton";
import type { Sale } from "@/lib/types";
import { Badge } from "../ui/Badge";
import { CATEGORY_LABELS, GENDER_LABELS, PAYMENT_METHOD_LABELS } from "@/lib/types";
import { formatPrice, formatDate, cn } from "@/lib/utils";

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
  const saleDate = new Date(sale.saleDate);

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
              {formatDate(saleDate)}
            </div>
            <span className="mr-5 opacity-70">
              {saleDate.toLocaleTimeString("ar-EG", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
          <h3 className="font-bold text-lg leading-tight mt-1">{sale.productName}</h3>
          {sale.brand && (
            <p className="text-sm text-text-secondary flex items-center gap-1">
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
                title="عرض كل فواتير هذا العميل"
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
                {PAYMENT_METHOD_LABELS[sale.paymentMethod]}
                {sale.paymentMethod === "deferred" && (sale.isPaid ? " ✓" : "")}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          {sale.isReturned ? (
            <Badge variant="returned">مرتجع</Badge>
          ) : (
            <Badge variant="sold">مباع</Badge>
          )}
          <Badge variant={sale.category}>{CATEGORY_LABELS[sale.category]}</Badge>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4 p-3 bg-gray-50 rounded-lg border border-gray-100">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-text-secondary mb-0.5">الكمية المباعة</p>
          <p className="text-lg font-black leading-none">{sale.quantitySold} قطعة</p>
        </div>
        <div className="text-end">
          <p className="text-[10px] uppercase tracking-wider text-text-secondary mb-0.5">سعر الوحدة</p>
          <p className="text-lg font-black leading-none">{formatPrice(sale.pricePerUnit)}</p>
        </div>
      </div>

      {/* Discount Info */}
      {sale.discountAmount && sale.discountAmount > 0 && (
        <div className="flex items-center justify-between mb-3 px-1">
          <span className="text-xs text-danger font-bold">
            خصم {sale.discountType === "percentage" ? `${sale.discountValue}%` : formatPrice(sale.discountAmount)}
          </span>
          <span className="text-xs text-text-secondary line-through opacity-60 italic">
            {formatPrice(sale.subtotal)}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between pt-2 border-t border-gray-100">
        <div>
          <p className="text-xs text-text-secondary mb-0.5 font-medium">الإجمالي</p>
          <p className="text-2xl font-black text-accent">{formatPrice(sale.totalPrice)}</p>
        </div>
        
        <div className="flex flex-col gap-2">
          {!sale.isReturned && (
            <button
              onClick={() => onPrint(sale)}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent/90 font-bold shadow-lg shadow-accent/20 border border-accent/20 text-sm"
            >
              <Printer className="w-4 h-4" />
              طباعة
            </button>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => onEdit(sale)}
              disabled={sale.isReturned}
              className="flex-1 flex items-center justify-center gap-1 px-3 py-2 bg-gray-100 text-text-secondary rounded-xl hover:bg-gray-200 disabled:opacity-40 text-sm"
            >
              <Pencil className="w-4 h-4" />
              تعديل
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
              مرتجع
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
            title="حذف الفاتورة وإرجاع المخزون"
          >
            <Trash2 className="w-3.5 h-3.5" />
            حذف الفاتورة
          </button>
        </div>
      </div>
    </div>
  );
}
