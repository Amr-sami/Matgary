"use client";

import { RotateCcw, Printer, Pencil, Trash2 } from "@/lib/icons";
import { ShareReceiptButton } from "./ShareReceiptButton";
import type { Sale } from "@/lib/types";
import { Badge } from "../ui/Badge";
import { CATEGORY_LABELS, GENDER_LABELS, PAYMENT_METHOD_LABELS } from "@/lib/types";
import { formatPrice, formatDate } from "@/lib/utils";

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
  const saleDate = new Date(sale.saleDate);

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
            {formatDate(saleDate)}
          </span>
          <span className="text-xs text-text-secondary opacity-80">
            {saleDate.toLocaleTimeString("ar-EG", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
      </td>
      <td className="py-4 px-4 font-medium">
        <div>
          {sale.productName}
          <div className="flex flex-wrap gap-1 mt-0.5">
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
      </td>
      <td className="py-4 px-4">
        <Badge variant={sale.category}>{CATEGORY_LABELS[sale.category]}</Badge>
      </td>
      <td className="py-4 px-4 text-sm text-text-secondary">{sale.brand || "-"}</td>
      <td className="py-4 px-4 text-center font-semibold">{sale.quantitySold}</td>
      <td className="py-4 px-4 text-sm font-medium">{formatPrice(sale.pricePerUnit)}</td>
      <td className="py-4 px-4">
        <div className="flex flex-col">
          <span className="font-bold text-accent">{formatPrice(sale.totalPrice)}</span>
          {sale.discountAmount && sale.discountAmount > 0 && (
            <div className="flex flex-col text-[10px] items-start mt-0.5">
              <span className="text-text-secondary line-through italic opacity-60">
                {formatPrice(sale.subtotal)}
              </span>
              <span className="text-danger font-bold">
                خصم {sale.discountType === "percentage" ? `${sale.discountValue}%` : formatPrice(sale.discountAmount)}
              </span>
            </div>
          )}
        </div>
      </td>
      <td className="py-4 px-4">
        {sale.isReturned ? (
          <Badge variant="returned">مرتجع</Badge>
        ) : (
          <Badge variant="sold">مباع</Badge>
        )}
      </td>
      <td className="py-4 px-4">
        <div className="flex items-center gap-2">
          {!sale.isReturned && (
            <button
              onClick={() => onPrint(sale)}
              className="p-1.5 bg-accent-light text-accent rounded-lg hover:bg-accent hover:text-white border border-accent/20"
              title="طباعة"
            >
              <Printer className="w-4 h-4" />
            </button>
          )}
          {!sale.isReturned && <ShareReceiptButton sale={sale} />}
          <button
            onClick={() => onEdit(sale)}
            disabled={sale.isReturned}
            className="p-1.5 bg-gray-100 text-text-secondary rounded-lg hover:bg-gray-200 disabled:opacity-40"
            title="تعديل"
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            onClick={() => onReturn(sale)}
            disabled={sale.isReturned}
            className="p-1.5 bg-danger-light text-danger rounded-lg hover:bg-danger hover:text-white disabled:opacity-40 border border-danger/20"
            title="مرتجع"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <button
            onClick={() => onVoid(sale)}
            className="p-1.5 bg-gray-100 text-text-secondary rounded-lg hover:bg-danger hover:text-white"
            title="حذف الفاتورة (إرجاع للمخزن)"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}