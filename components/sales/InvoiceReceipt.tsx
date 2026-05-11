"use client";

import type { ReceiptInvoiceData } from "./SaleForm";
import { useShopSettings } from "@/hooks/useShopSettings";
import { rl } from "@/lib/receipt-strings";

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

function qrImageUrl(payload: string): string {
  const data = encodeURIComponent(payload);
  return `https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=0&ecc=M&data=${data}`;
}

export function InvoiceReceipt({ invoice }: { invoice: ReceiptInvoiceData }) {
  const { settings } = useShopSettings();
  const lang = settings.receiptLanguage;
  const code = (invoice.invoiceId || invoice.saleDate.getTime().toString())
    .slice(-10)
    .toUpperCase();
  const shopName = (settings.shopName || "STORE").toUpperCase();
  const shopPhone = settings.shopPhone || "";
  const qrPayload = invoice.invoiceId
    ? `INVOICE ${invoice.invoiceId}`
    : shopPhone
      ? `tel:${shopPhone.replace(/\D/g, "")}`
      : `RECEIPT ${code}`;
  const qrUrl = qrImageUrl(qrPayload);
  const logoSrc = "/logo.png";

  const lineDiscountsTotal = invoice.lines.reduce(
    (s, l) => s + l.lineDiscountAmount,
    0,
  );

  const showLoyalty =
    settings.receiptShowLoyalty &&
    ((invoice.loyaltyPointsRedeemed ?? 0) > 0 ||
      (invoice.loyaltyCreditApplied ?? 0) > 0 ||
      (invoice.loyaltyPointsEarned ?? 0) > 0 ||
      invoice.loyaltyPointsBalance !== undefined);

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
              <div className="receipt-item-sub">
                {rl("brand", lang)}: {line.brand}
              </div>
            )}
            {line.quantity > 1 && (
              <div className="receipt-item-sub">
                x{line.quantity} @ {formatMoney(line.pricePerUnit)}
              </div>
            )}
            {line.lineDiscountAmount > 0 && (
              <div className="receipt-item-sub">
                {rl("discount", lang)} (- {formatMoney(line.lineDiscountAmount)})
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      <div className="receipt-row">
        <span>{rl("subtotal", lang)}</span>
        <span>{formatMoney(invoice.cartSubtotal)}</span>
      </div>
      {lineDiscountsTotal > 0 && (
        <div className="receipt-row">
          <span>{rl("lineDiscounts", lang)}</span>
          <span>- {formatMoney(lineDiscountsTotal)}</span>
        </div>
      )}
      {invoice.orderDiscountAmount > 0 && (
        <div className="receipt-row">
          <span>{rl("orderDiscount", lang)}</span>
          <span>- {formatMoney(invoice.orderDiscountAmount)}</span>
        </div>
      )}
      {showLoyalty && (invoice.loyaltyPointsRedeemed ?? 0) > 0 && (
        <div className="receipt-row">
          <span>
            {rl("loyaltyPoints", lang)} (×{invoice.loyaltyPointsRedeemed})
          </span>
          <span>—</span>
        </div>
      )}
      {showLoyalty && (invoice.loyaltyCreditApplied ?? 0) > 0 && (
        <div className="receipt-row">
          <span>{rl("loyaltyCredit", lang)}</span>
          <span>- {formatMoney(invoice.loyaltyCreditApplied!)}</span>
        </div>
      )}

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      <div className="receipt-row receipt-total-row">
        <span>{rl("total", lang)}</span>
        <span>{formatMoney(invoice.totalPrice)}</span>
      </div>

      {showLoyalty &&
        ((invoice.loyaltyPointsEarned ?? 0) > 0 ||
          invoice.loyaltyPointsBalance !== undefined) && (
          <>
            <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>
            {(invoice.loyaltyPointsEarned ?? 0) > 0 && (
              <div className="receipt-row">
                <span>{rl("loyaltyEarned", lang)}</span>
                <span>+{invoice.loyaltyPointsEarned}</span>
              </div>
            )}
            {invoice.loyaltyPointsBalance !== undefined && (
              <div className="receipt-row">
                <span>{rl("walletBalance", lang)}</span>
                <span>
                  {invoice.loyaltyPointsBalance} pt
                  {invoice.loyaltyCreditBalance
                    ? ` · ${formatMoney(invoice.loyaltyCreditBalance)}`
                    : ""}
                </span>
              </div>
            )}
          </>
        )}

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      <div className="receipt-thankyou">{rl("thankYou", lang)}</div>

      {settings.receiptFooterText && (
        <div className="receipt-footer">{settings.receiptFooterText}</div>
      )}

      <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>

      <div className="receipt-qr">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qrUrl} alt={`QR ${code}`} width={120} height={120} className="receipt-qr-img" />
      </div>
      <div className="receipt-barcode-text">#{code}</div>
    </div>
  );
}
