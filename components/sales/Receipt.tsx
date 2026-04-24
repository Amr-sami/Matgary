"use client";

import type { DiscountType } from "@/lib/types";

interface ReceiptSaleData {
  saleId?: string;
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

function formatMoney(n: number): string {
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;
}

function formatReceiptDate(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  const dd = pad(d.getDate());
  const mm = pad(d.getMonth() + 1);
  const yy = d.getFullYear();
  const hh = pad(d.getHours() % 12 || 12);
  const mi = pad(d.getMinutes());
  const ampm = d.getHours() >= 12 ? "PM" : "AM";
  return `${dd}/${mm}/${yy} - ${hh}:${mi} ${ampm}`;
}

// Pseudo-code derived from sale id or timestamp — for the barcode + short number
function shortCode(sale: ReceiptSaleData): string {
  if (sale.saleId) return sale.saleId.slice(-10).toUpperCase();
  const t = sale.saleDate.getTime().toString();
  return t.slice(-10);
}

// Build a deterministic barcode-like pattern (variable-width vertical bars)
// from the short code. Not a real scannable barcode — purely visual.
function barcodeBars(code: string): { width: number; filled: boolean }[] {
  const bars: { width: number; filled: boolean }[] = [];
  const seed = code.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  for (let i = 0; i < 48; i++) {
    const v = (seed * (i + 7)) % 11;
    bars.push({ width: 1 + (v % 3), filled: v % 2 === 0 });
  }
  return bars;
}

export function Receipt({ sale }: ReceiptProps) {
  const code = shortCode(sale);
  const bars = barcodeBars(code);

  return (
    <div className="receipt" dir="ltr">
      {/* Top slogan */}
      <div className="receipt-slogan">CORNER STORE · العاشر من رمضان</div>

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      {/* Title */}
      <h1 className="receipt-title">*** RECEIPT ***</h1>

      {/* Cashier + Date */}
      <div className="receipt-row">
        <span>CORNER STORE</span>
        <span>{formatReceiptDate(sale.saleDate)}</span>
      </div>

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      {/* Items */}
      <div className="receipt-items">
        <div className="receipt-row receipt-item-main">
          <span className="receipt-item-name">{sale.productName}</span>
          <span className="receipt-item-price">{formatMoney(sale.subtotal)}</span>
        </div>
        {sale.brand && (
          <div className="receipt-item-sub">BRAND: {sale.brand}</div>
        )}
        {sale.quantity > 1 && (
          <div className="receipt-item-sub">
            x{sale.quantity} @ {formatMoney(sale.pricePerUnit)}
          </div>
        )}
        {sale.discountAmount > 0 && (
          <div className="receipt-item-sub">
            DISC.{" "}
            {sale.discountType === "percentage"
              ? `${sale.discountValue}% `
              : "FIXED "}
            (- {formatMoney(sale.discountAmount)})
          </div>
        )}
      </div>

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      {/* Subtotal + Discount */}
      <div className="receipt-row">
        <span>SUBTOTAL</span>
        <span>{formatMoney(sale.subtotal)}</span>
      </div>
      {sale.discountAmount > 0 && (
        <div className="receipt-row">
          <span>DISCOUNT</span>
          <span>- {formatMoney(sale.discountAmount)}</span>
        </div>
      )}

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      {/* Total */}
      <div className="receipt-row receipt-total-row">
        <span>TOTAL AMOUNT</span>
        <span>{formatMoney(sale.totalPrice)}</span>
      </div>

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      {/* Thank you */}
      <div className="receipt-thankyou">THANK YOU FOR SHOPPING!</div>
      <div className="receipt-thankyou-ar">شكراً لتسوقكم معنا ❤</div>

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      {/* Barcode */}
      <div className="receipt-barcode">
        {bars.map((b, i) => (
          <span
            key={i}
            className="receipt-bar"
            style={{
              width: `${b.width}px`,
              background: b.filled ? "#000" : "transparent",
            }}
          />
        ))}
      </div>
      <div className="receipt-barcode-text">#{code}</div>
    </div>
  );
}
