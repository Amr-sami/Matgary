"use client";

import { useState } from "react";
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

function shortCode(sale: ReceiptSaleData): string {
  if (sale.saleId) return sale.saleId.slice(-10).toUpperCase();
  return sale.saleDate.getTime().toString().slice(-10);
}

const STORE_PHONE = "01500228266";
const STORE_LOCATION_AR = "العاشر من رمضان · الأردنية، خلف فودافون";
const STORE_LOCATION_EN = "10th of Ramadan City - El Ordnia, behind Vodafone";

function publicReceiptUrl(saleId: string | undefined, origin: string): string {
  const base = origin || "";
  if (!saleId) return `${base}/`;
  return `${base}/r/${saleId}`;
}

function qrImageUrl(payload: string): string {
  const data = encodeURIComponent(payload);
  return `https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=0&ecc=M&data=${data}`;
}

export function Receipt({ sale }: ReceiptProps) {
  const code = shortCode(sale);
  const [origin] = useState(() =>
    typeof window !== "undefined" ? window.location.origin : ""
  );

  const receiptUrl = publicReceiptUrl(sale.saleId, origin);
  const qrUrl = qrImageUrl(receiptUrl);

  return (
    <div className="receipt" dir="ltr">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="Corner Store" className="receipt-logo" />
      <div className="receipt-slogan">CORNER STORE · العاشر من رمضان</div>
      <div className="receipt-contact">TEL: {STORE_PHONE}</div>
      <div className="receipt-contact">{STORE_LOCATION_EN}</div>
      <div className="receipt-contact-ar">{STORE_LOCATION_AR}</div>

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      <h1 className="receipt-title">*** RECEIPT ***</h1>

      <div className="receipt-row">
        <span>CORNER STORE</span>
        <span>{formatReceiptDate(sale.saleDate)}</span>
      </div>

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

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

      <div className="receipt-row receipt-total-row">
        <span>TOTAL AMOUNT</span>
        <span>{formatMoney(sale.totalPrice)}</span>
      </div>

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      <div className="receipt-thankyou">THANK YOU FOR SHOPPING!</div>
      <div className="receipt-thankyou-ar">شكراً لتسوقكم معنا ❤</div>

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
      <div className="receipt-qr-hint">SCAN FOR PDF · امسح للفاتورة</div>
      <div className="receipt-barcode-text">#{code}</div>
    </div>
  );
}
