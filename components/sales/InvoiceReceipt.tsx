"use client";

import type { ReceiptInvoiceData } from "./SaleForm";

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

const STORE_PHONE = "01500228266";
const STORE_LOCATION_AR = "العاشر من رمضان · الأردنية، خلف فودافون";
const STORE_LOCATION_EN = "10th of Ramadan City - El Ordnia, behind Vodafone";
const STORE_WEBSITE = "https://cornerwatcesstore.com";

function qrImageUrl(payload: string): string {
  const data = encodeURIComponent(payload);
  return `https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=0&ecc=M&data=${data}`;
}

export function InvoiceReceipt({ invoice }: { invoice: ReceiptInvoiceData }) {
  const code = (invoice.invoiceId || invoice.saleDate.getTime().toString())
    .slice(-10)
    .toUpperCase();
  const qrUrl = qrImageUrl(STORE_WEBSITE);
  const lineDiscountsTotal = invoice.lines.reduce((s, l) => s + l.lineDiscountAmount, 0);

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
        <span>{formatReceiptDate(invoice.saleDate)}</span>
      </div>

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      <div className="receipt-items">
        {invoice.lines.map((line, idx) => (
          <div key={idx}>
            <div className="receipt-row receipt-item-main">
              <span className="receipt-item-name">{line.productName}</span>
              <span className="receipt-item-price">{formatMoney(line.subtotal)}</span>
            </div>
            {line.brand && (
              <div className="receipt-item-sub">BRAND: {line.brand}</div>
            )}
            {line.quantity > 1 && (
              <div className="receipt-item-sub">
                x{line.quantity} @ {formatMoney(line.pricePerUnit)}
              </div>
            )}
            {line.lineDiscountAmount > 0 && (
              <div className="receipt-item-sub">
                LINE DISC. (- {formatMoney(line.lineDiscountAmount)})
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      <div className="receipt-row">
        <span>SUBTOTAL</span>
        <span>{formatMoney(invoice.cartSubtotal)}</span>
      </div>
      {lineDiscountsTotal > 0 && (
        <div className="receipt-row">
          <span>LINE DISCOUNTS</span>
          <span>- {formatMoney(lineDiscountsTotal)}</span>
        </div>
      )}
      {invoice.orderDiscountAmount > 0 && (
        <div className="receipt-row">
          <span>ORDER DISCOUNT</span>
          <span>- {formatMoney(invoice.orderDiscountAmount)}</span>
        </div>
      )}

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      <div className="receipt-row receipt-total-row">
        <span>TOTAL AMOUNT</span>
        <span>{formatMoney(invoice.totalPrice)}</span>
      </div>

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      <div className="receipt-thankyou">THANK YOU FOR SHOPPING!</div>
      <div className="receipt-thankyou-ar">شكراً لتسوقكم معنا ❤</div>

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      <div className="receipt-qr">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qrUrl} alt={`QR ${code}`} width={120} height={120} className="receipt-qr-img" />
      </div>
      <div className="receipt-qr-hint">SCAN TO VISIT · {STORE_WEBSITE.replace("https://", "")}</div>
      <div className="receipt-barcode-text">#{code}</div>
    </div>
  );
}
