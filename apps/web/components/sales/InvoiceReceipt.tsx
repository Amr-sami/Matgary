"use client";

import type { ReceiptInvoiceData } from "./SaleForm";
import type { ReceiptBlockKey, ReceiptFixedBlock } from "@/lib/settings";
import { useShopSettings } from "@/hooks/useShopSettings";
import { receiptPaymentRows, rl, type ReceiptPayment } from "@/lib/receipt-strings";

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

const FONT_VAR: Record<string, string> = {
  cairo: "var(--font-cairo)",
  tajawal: "var(--font-display)",
  lemonada: "var(--font-catchy)",
};

/** Doc 15 spec 13 §4.15: the payment row's data. Typed here so this file
 *  compiles before (and after) 12 adds the same field to ReceiptInvoiceData. */
type InvoiceReceiptData = ReceiptInvoiceData & { payment?: ReceiptPayment };

export function InvoiceReceipt({ invoice }: { invoice: InvoiceReceiptData }) {
  const { settings } = useShopSettings();
  const lang = settings.receiptLanguage;
  const shortCode = (invoice.invoiceId || invoice.saleDate.getTime().toString())
    .slice(-10)
    .toUpperCase();
  const prefix = (settings.receiptReferencePrefix || "").trim().toUpperCase();
  const code = prefix ? `${prefix}-${shortCode}` : shortCode;
  const shopName = (settings.shopName || "STORE").toUpperCase();
  const shopPhone = settings.shopPhone || "";
  // Identity rows honor BOTH the text ("empty = hidden") AND the per-row
  // visibility toggle ("show flag off → hidden even when text is set").
  // Tax reg and tax card share a single toggle — the Owner prints tax info
  // or doesn't; splitting the toggle gets no UX win.
  const shopAddress =
    settings.receiptShowAddress ? (settings.receiptAddress || "").trim() : "";
  const slogan =
    settings.receiptShowSlogan ? (settings.receiptSlogan || "").trim() : "";
  const taxReg =
    settings.receiptShowTaxInfo ? (settings.receiptTaxRegistration || "").trim() : "";
  const taxCard =
    settings.receiptShowTaxInfo ? (settings.receiptTaxCardNumber || "").trim() : "";
  const returnPolicy =
    settings.receiptShowReturnPolicy ? (settings.receiptReturnPolicy || "").trim() : "";
  // Per-row alignment overrides (0067). Missing key → center (today's shape).
  const aligns = settings.receiptBlockAlignments ?? {};
  const alignStyle = (key: string): React.CSSProperties => {
    const v = aligns[key];
    return { textAlign: v === "left" || v === "right" ? v : "center" };
  };
  const qrPayload = invoice.invoiceId
    ? `INVOICE ${invoice.invoiceId}`
    : shopPhone
      ? `tel:${shopPhone.replace(/\D/g, "")}`
      : `RECEIPT ${code}`;
  const qrUrl = qrImageUrl(qrPayload);
  const logoSrc = settings.receiptLogoUrl || "/logo.png";

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

  const FIXED_BLOCKS: Record<ReceiptFixedBlock, React.ReactNode> = {
    logo:
      settings.receiptLogoSize !== "hidden" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoSrc}
          alt={shopName}
          className={`receipt-logo receipt-logo--${settings.receiptLogoSize}`}
        />
      ) : null,
    shopInfo: (
      <>
        <div className="receipt-slogan" style={alignStyle("name")}>{shopName}</div>
        {shopAddress && (
          <div className="receipt-contact whitespace-pre-wrap" dir="auto" style={alignStyle("address")}>
            {shopAddress}
          </div>
        )}
        {shopPhone && (
          <div className="receipt-contact" style={alignStyle("phone")}>
            {rl("tel", lang)}: {shopPhone}
          </div>
        )}
        {slogan && (
          <div className="receipt-contact" dir="auto" style={alignStyle("slogan")}>
            {slogan}
          </div>
        )}
        {taxReg && (
          <div className="receipt-contact" dir="auto" style={alignStyle("taxReg")}>
            {rl("taxRegistration", lang)}: {taxReg}
          </div>
        )}
        {taxCard && (
          <div className="receipt-contact" dir="auto" style={alignStyle("taxCard")}>
            {rl("taxCard", lang)}: {taxCard}
          </div>
        )}
      </>
    ),
    purchaseDate: (
      <div className="receipt-row">
        <span>{shopName}</span>
        <span>{formatReceiptDate(invoice.saleDate)}</span>
      </div>
    ),
    items: (
      <>
        <h1 className="receipt-title">{rl("receipt", lang)}</h1>
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
      </>
    ),
    totals: (
      <>
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
        {/* Partial-payment lines — only when the down-payment is short of
            the total. Doubles as an IOU the customer can reference when
            they come back to settle. */}
        {typeof invoice.amountPaid === "number" &&
          invoice.amountPaid < invoice.totalPrice && (
            <>
              <div className="receipt-row">
                <span>{rl("paid", lang)}</span>
                <span>{formatMoney(invoice.amountPaid)}</span>
              </div>
              <div className="receipt-row receipt-total-row">
                <span>{rl("balance", lang)}</span>
                <span>
                  {formatMoney(invoice.totalPrice - invoice.amountPaid)}
                </span>
              </div>
            </>
          )}
        {/* Method + masked receiving account; never a status (13 §4.15). */}
        {receiptPaymentRows(invoice.payment, lang).map((r, i) => (
          <div key={`pay-${i}`} className="receipt-row">
            <span>{r.label}</span>
            <span dir="ltr">{r.value}</span>
          </div>
        ))}
      </>
    ),
    loyalty:
      showLoyalty &&
      ((invoice.loyaltyPointsEarned ?? 0) > 0 ||
        invoice.loyaltyPointsBalance !== undefined) ? (
        <>
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
      ) : null,
    footer: (
      <>
        <div className="receipt-thankyou">{rl("thankYou", lang)}</div>
        {returnPolicy && (
          <div className="receipt-footer whitespace-pre-wrap" dir="auto" style={alignStyle("returnPolicy")}>
            {returnPolicy}
          </div>
        )}
        {settings.receiptFooterText && (
          <div className="receipt-footer" style={alignStyle("footerText")}>{settings.receiptFooterText}</div>
        )}
        <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>
        <div className="receipt-qr">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrUrl} alt={`QR ${code}`} width={120} height={120} className="receipt-qr-img" />
        </div>
        <div className="receipt-barcode-text">#{code}</div>
      </>
    ),
  };

  const renderedBlocks: { key: ReceiptBlockKey; node: React.ReactNode }[] = [];
  for (const key of settings.receiptBlockOrder) {
    if (key.startsWith("custom:")) {
      const id = key.slice(7);
      const custom = settings.receiptCustomBlocks[id];
      if (!custom || !custom.text.trim()) continue;
      renderedBlocks.push({
        key,
        node: (
          <div
            className="receipt-custom-block whitespace-pre-wrap"
            style={{ textAlign: custom.align }}
            dir="auto"
          >
            {custom.text}
          </div>
        ),
      });
      continue;
    }
    const node = FIXED_BLOCKS[key as ReceiptFixedBlock];
    if (node) renderedBlocks.push({ key, node });
  }

  return (
    <div
      className="receipt"
      dir="ltr"
      style={{ fontFamily: `${FONT_VAR[settings.receiptFontFamily] ?? FONT_VAR.cairo}, 'Arial', sans-serif` }}
    >
      {renderedBlocks.map(({ key, node }, idx) => (
        <div key={key}>
          {node}
          {idx < renderedBlocks.length - 1 && (
            <div className="receipt-divider">- - - - - - - - - - - - - - - - - - - - - - - - -</div>
          )}
        </div>
      ))}
    </div>
  );
}
