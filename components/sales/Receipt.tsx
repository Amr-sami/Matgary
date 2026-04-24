"use client";

import { formatPrice, formatDate, formatDateTime } from "@/lib/utils";
import type { DiscountType } from "@/lib/types";

interface ReceiptSaleData {
  productName: string;
  brand?: string;
  quantity: number;
  pricePerUnit: number;
  subtotal: number;
  discountType?: DiscountType;
  discountValue?: number;
  discountAmount: number;
  totalPrice: number;
  saleDate: Date;
}

interface ReceiptProps {
  sale: ReceiptSaleData;
}

export function Receipt({ sale }: ReceiptProps) {
  const dateStr = formatDate(sale.saleDate);
  const timeStr = sale.saleDate.toLocaleTimeString("ar-EG", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="receipt" dir="rtl">
      {/* Header */}
      <div className="receipt-header">
        <div className="receipt-divider-double">═══════════════════════════</div>
        <h1 className="receipt-store-name">Corner Store</h1>
        <p className="receipt-subtitle">نظام إدارة المخزن</p>
        <div className="receipt-divider-double">═══════════════════════════</div>
      </div>

      {/* Date & Time */}
      <div className="receipt-row">
        <span>التاريخ:</span>
        <span>{dateStr}</span>
      </div>
      <div className="receipt-row">
        <span>الوقت:</span>
        <span>{timeStr}</span>
      </div>

      <div className="receipt-divider">───────────────────────────</div>

      {/* Product Info */}
      <div className="receipt-section">
        <div className="receipt-row">
          <span>المنتج:</span>
          <span>{sale.productName}</span>
        </div>
        {sale.brand && (
          <div className="receipt-row">
            <span>البراند:</span>
            <span>{sale.brand}</span>
          </div>
        )}
        <div className="receipt-row">
          <span>الكمية:</span>
          <span>{sale.quantity}</span>
        </div>
        <div className="receipt-row">
          <span>سعر الوحدة:</span>
          <span>{formatPrice(sale.pricePerUnit)}</span>
        </div>
      </div>

      <div className="receipt-divider">───────────────────────────</div>

      {/* Totals */}
      <div className="receipt-section">
        <div className="receipt-row">
          <span>المجموع:</span>
          <span>{formatPrice(sale.subtotal)}</span>
        </div>
        {sale.discountAmount > 0 && (
          <div className="receipt-row receipt-discount">
            <span>
              الخصم{sale.discountType === "percentage" ? ` (${sale.discountValue}%)` : ""}:
            </span>
            <span>- {formatPrice(sale.discountAmount)}</span>
          </div>
        )}
      </div>

      <div className="receipt-divider-double">═══════════════════════════</div>

      <div className="receipt-total">
        <div className="receipt-row receipt-total-row">
          <span>الإجمالي:</span>
          <span>{formatPrice(sale.totalPrice)}</span>
        </div>
      </div>

      <div className="receipt-divider-double">═══════════════════════════</div>

      {/* Footer */}
      <div className="receipt-footer">
        <p>العاشر من رمضان</p>
        <p>خلف فرع فودافون</p>
        <p className="receipt-spacer">&nbsp;</p>
        <p className="receipt-thankyou">❤ سعداء بخدمتكم ❤</p>
        <div className="receipt-divider-double">═══════════════════════════</div>
      </div>
    </div>
  );
}
