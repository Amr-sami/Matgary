"use client";

import type { DiscountType } from "@/lib/types";
import { useShopSettings } from "@/hooks/useShopSettings";
import { rl } from "@/lib/receipt-strings";

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

function shortCode(sale: ReceiptSaleData): string {
  if (sale.saleId) return sale.saleId.slice(-10).toUpperCase();
  return sale.saleDate.getTime().toString().slice(-10);
}

function qrImageUrl(payload: string): string {
  const data = encodeURIComponent(payload);
  return `https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=0&ecc=M&data=${data}`;
}

export function Receipt({ sale }: ReceiptProps) {
  const { settings } = useShopSettings();
  const code = shortCode(sale);
  const lang = settings.receiptLanguage;
  const shopName = (settings.shopName || "STORE").toUpperCase();
  const shopPhone = settings.shopPhone || "";
  const qrPayload = shopPhone
    ? `tel:${shopPhone.replace(/\D/g, "")}`
    : `INVOICE ${code}`;
  const qrUrl = qrImageUrl(qrPayload);
  const logoSrc = "/logo.png";

  return (
    <div className="receipt" dir="ltr">
      {settings.receiptLogoSize !== "hidden" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoSrc}
          alt={shopName}
          className={`receipt-logo receipt-logo--${settings.receiptLogoSize}`}
        />
      )}
      <div className="receipt-slogan">{shopName}</div>
      {shopPhone && (
        <div className="receipt-contact">
          {rl("tel", lang)}: {shopPhone}
        </div>
      )}

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      <h1 className="receipt-title">{rl("receipt", lang)}</h1>

      <div className="receipt-row">
        <span>{shopName}</span>
        <span>{formatReceiptDate(sale.saleDate)}</span>
      </div>

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      <div className="receipt-items">
        <div className="receipt-row receipt-item-main">
          <span className="receipt-item-name">{sale.productName}</span>
          <span className="receipt-item-price">{formatMoney(sale.subtotal)}</span>
        </div>
        {sale.brand && (
          <div className="receipt-item-sub">
            {rl("brand", lang)}: {sale.brand}
          </div>
        )}
        {sale.quantity > 1 && (
          <div className="receipt-item-sub">
            x{sale.quantity} @ {formatMoney(sale.pricePerUnit)}
          </div>
        )}
        {sale.discountAmount > 0 && (
          <div className="receipt-item-sub">
            {rl("discount", lang)}{" "}
            {sale.discountType === "percentage"
              ? `${sale.discountValue}% `
              : ""}
            (- {formatMoney(sale.discountAmount)})
          </div>
        )}
      </div>

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      <div className="receipt-row">
        <span>{rl("subtotal", lang)}</span>
        <span>{formatMoney(sale.subtotal)}</span>
      </div>
      {sale.discountAmount > 0 && (
        <div className="receipt-row">
          <span>{rl("discount", lang)}</span>
          <span>- {formatMoney(sale.discountAmount)}</span>
        </div>
      )}

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      <div className="receipt-row receipt-total-row">
        <span>{rl("total", lang)}</span>
        <span>{formatMoney(sale.totalPrice)}</span>
      </div>

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      <div className="receipt-thankyou">{rl("thankYou", lang)}</div>

      {settings.receiptFooterText && (
        <div className="receipt-footer">{settings.receiptFooterText}</div>
      )}

      {/* Egyptian Tax Authority disclaimer — this receipt is operational, not
          an e-invoice. VAT-registered merchants must issue separate ETA
          invoices. Tiny font keeps it from dominating the print. */}
      <div className="receipt-eta-notice">
        إيصال للأغراض التشغيلية — ليس فاتورة ضريبية إلكترونية معتمدة من ETA.
      </div>

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      <div className="receipt-qr">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={qrUrl}
          alt={`QR ${code}`}
          width={120}
          height={120}
          className="receipt-qr-img"
        />
      </div>
      <div className="receipt-barcode-text">#{code}</div>
    </div>
  );
}
