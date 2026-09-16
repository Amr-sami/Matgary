"use client";

import type { DiscountType } from "@/lib/types";
import type { ReceiptBlockKey, ReceiptFixedBlock } from "@/lib/settings";
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
  /** Partial payments: when present and < totalPrice we surface a Paid /
   *  Balance line pair below the total so the customer can see what's
   *  on account. Omitting (or passing a value equal to totalPrice) keeps
   *  the receipt clean for the fully-paid case. */
  amountPaid?: number;
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

const FONT_VAR: Record<string, string> = {
  cairo: "var(--font-cairo)",
  tajawal: "var(--font-display)",
  lemonada: "var(--font-catchy)",
};

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
  // Custom upload wins; bundled /logo.png is the fallback so historical
  // tenants render unchanged. The settings UI can clear receiptLogoUrl to
  // get back to the static default.
  const logoSrc = settings.receiptLogoUrl || "/logo.png";

  // Each block renders to JSX or null. The order array drives composition;
  // dividers go between non-empty blocks so we don't draw two in a row.
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
        <div className="receipt-slogan">{shopName}</div>
        {shopPhone && (
          <div className="receipt-contact">
            {rl("tel", lang)}: {shopPhone}
          </div>
        )}
      </>
    ),
    purchaseDate: (
      <div className="receipt-row">
        <span>{shopName}</span>
        <span>{formatReceiptDate(sale.saleDate)}</span>
      </div>
    ),
    items: (
      <>
        <h1 className="receipt-title">{rl("receipt", lang)}</h1>
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
      </>
    ),
    totals: (
      <>
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
        {/* Partial-payment lines — only when there's a real balance. The
            customer's copy doubles as a receipt + an IOU. */}
        {typeof sale.amountPaid === "number" &&
          sale.amountPaid < sale.totalPrice && (
            <>
              <div className="receipt-row">
                <span>{rl("paid", lang)}</span>
                <span>{formatMoney(sale.amountPaid)}</span>
              </div>
              <div className="receipt-row receipt-total-row">
                <span>{rl("balance", lang)}</span>
                <span>{formatMoney(sale.totalPrice - sale.amountPaid)}</span>
              </div>
            </>
          )}
      </>
    ),
    // Single-item Receipt has no loyalty surface — keep the slot so the
    // settings UI can still list the block, just renders nothing here.
    loyalty: null,
    footer: (
      <>
        <div className="receipt-thankyou">{rl("thankYou", lang)}</div>
        {settings.receiptFooterText && (
          <div className="receipt-footer">{settings.receiptFooterText}</div>
        )}
        {/* ETA disclaimer + QR are always the last lines — they're regulatory
            and traceability, not part of the customisable layout. */}
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
