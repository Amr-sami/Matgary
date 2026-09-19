/**
 * Receipt → self-contained HTML.
 *
 * Source of truth is the web's `components/sales/InvoiceReceipt.tsx` +
 * `Receipt.tsx` and the print CSS block in `app/globals.css` (`.receipt-*`).
 * Same block order, same labels (`lib/receipt-strings.ts`), same dividers,
 * same money shape (`1,234.00 ج.م`) — a customer holding the phone PDF next
 * to a web print-out should not be able to tell them apart.
 *
 * Doc 06 §4.3: no Intl anywhere in here. Digits are grouped by `groupDigits`
 * from "@/lib/format" (plain string ops), dates are padded by hand.
 *
 * Fonts: Cairo is not bundled in the app, so the Arabic stack is the OS's —
 * Geeza Pro / Noto Naskh via `system-ui`. Latin monospace keeps the web's
 * Menlo/Courier look (Menlo ships on iOS).
 */

import { groupDigits } from "@/lib/format";

export type ReceiptWidth = 58 | 80;

export type ReceiptLanguage = "ar" | "en" | "bilingual";
export type ReceiptLogoSize = "hidden" | "small" | "medium" | "large";
export type ReceiptFixedBlock =
  | "logo"
  | "shopInfo"
  | "purchaseDate"
  | "items"
  | "totals"
  | "loyalty"
  | "footer";
export type ReceiptBlockKey = ReceiptFixedBlock | `custom:${string}`;

/** The slice of GET /api/settings `.data` the receipt reads. */
export interface ReceiptSettings {
  shopName: string;
  shopPhone: string;
  receiptLanguage: ReceiptLanguage;
  receiptLogoSize: ReceiptLogoSize;
  receiptLogoUrl: string;
  receiptFooterText: string;
  receiptShowLoyalty: boolean;
  receiptBlockOrder: ReceiptBlockKey[];
  receiptCustomBlocks: Record<string, { text: string; align: "right" | "center" | "left" }>;
  receiptFontFamily?: string;
}

export const DEFAULT_RECEIPT_SETTINGS: ReceiptSettings = {
  shopName: "",
  shopPhone: "",
  receiptLanguage: "ar",
  receiptLogoSize: "medium",
  receiptLogoUrl: "",
  receiptFooterText: "",
  receiptShowLoyalty: true,
  receiptBlockOrder: ["logo", "shopInfo", "purchaseDate", "items", "totals", "loyalty", "footer"],
  receiptCustomBlocks: {},
};

export interface ReceiptLine {
  productName: string;
  brand?: string | null;
  quantity: number;
  pricePerUnit: number;
  /** quantity × pricePerUnit, before the line discount. */
  subtotal: number;
  lineDiscountAmount: number;
}

/** Mirrors the web's ReceiptInvoiceData (SaleForm.tsx). */
export interface ReceiptSale {
  invoiceId: string;
  saleDate: Date;
  lines: ReceiptLine[];
  cartSubtotal: number;
  orderDiscountAmount: number;
  totalPrice: number;
  amountPaid?: number;
  loyaltyPointsRedeemed?: number;
  loyaltyCreditApplied?: number;
  loyaltyPointsEarned?: number;
  loyaltyPointsBalance?: number;
  loyaltyCreditBalance?: number;
}

export interface BuildReceiptOptions {
  width: ReceiptWidth;
  /**
   * Pre-resolved `data:` URIs. The PDF renderer snapshots the page as soon as
   * layout settles, so a remote <img> races the snapshot and usually loses —
   * callers fetch and inline first (see share.ts). Omitted → the block is
   * skipped rather than printing a broken-image glyph.
   */
  logoDataUri?: string;
  qrDataUri?: string;
}

// ---------------------------------------------------------------------------
// Labels — copied verbatim from apps/web/lib/receipt-strings.ts.

const LABELS = {
  receipt: { en: "*** RECEIPT ***", ar: "*** فاتورة ***" },
  subtotal: { en: "SUBTOTAL", ar: "المجموع" },
  discount: { en: "DISCOUNT", ar: "الخصم" },
  lineDiscounts: { en: "LINE DISCOUNTS", ar: "خصومات الأصناف" },
  orderDiscount: { en: "ORDER DISCOUNT", ar: "خصم الفاتورة" },
  loyaltyPoints: { en: "POINTS REDEEMED", ar: "نقاط مستخدمة" },
  loyaltyCredit: { en: "CREDIT APPLIED", ar: "رصيد مستخدم" },
  loyaltyEarned: { en: "POINTS EARNED", ar: "نقاط مكتسبة" },
  walletBalance: { en: "WALLET BALANCE", ar: "رصيد المحفظة" },
  total: { en: "TOTAL AMOUNT", ar: "الإجمالي" },
  paid: { en: "PAID", ar: "مدفوع" },
  balance: { en: "ON ACCOUNT", ar: "متبقي على الحساب" },
  thankYou: { en: "THANK YOU FOR SHOPPING!", ar: "شكراً لتسوقكم معنا" },
  brand: { en: "BRAND", ar: "الماركة" },
  tel: { en: "TEL", ar: "هاتف" },
} as const;

type LabelKey = keyof typeof LABELS;

function rl(key: LabelKey, lang: ReceiptLanguage): string {
  const pair = LABELS[key];
  if (lang === "ar") return pair.ar;
  if (lang === "en") return pair.en;
  return `${pair.en} · ${pair.ar}`;
}

// ---------------------------------------------------------------------------
// Formatting — deterministic, matches Receipt.tsx#formatMoney / formatReceiptDate.

/** 2300.5 → "2,300.50 ج.م" — the receipt always prints two decimals. */
export function receiptMoney(n: number): string {
  const neg = n < 0;
  const cents = Math.round(Math.abs(n) * 100);
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  return `${neg ? "-" : ""}${groupDigits(whole)}.${frac} ج.م`;
}

/** "18/09/2026 - 07:32 PM" */
export function receiptDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const hh = pad(d.getHours() % 12 || 12);
  const ampm = d.getHours() >= 12 ? "PM" : "AM";
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} - ${hh}:${pad(d.getMinutes())} ${ampm}`;
}

/** Last 10 chars of the invoice id, upper-cased — the web's `shortCode`. */
export function receiptCode(sale: Pick<ReceiptSale, "invoiceId" | "saleDate">): string {
  const base = sale.invoiceId || String(sale.saleDate.getTime());
  return base.slice(-10).toUpperCase();
}

/** What the web encodes in the QR: the invoice id when there is one. */
export function receiptQrPayload(sale: ReceiptSale, settings: ReceiptSettings): string {
  if (sale.invoiceId) return `INVOICE ${sale.invoiceId}`;
  const phone = settings.shopPhone.replace(/\D/g, "");
  return phone ? `tel:${phone}` : `RECEIPT ${receiptCode(sale)}`;
}

/** The web's fallback when the tenant has not uploaded a logo. */
export const DEFAULT_LOGO_PATH = "/logo.png";

export function receiptLogoUrl(settings: ReceiptSettings, apiBaseUrl: string): string | null {
  if (settings.receiptLogoSize === "hidden") return null;
  const raw = settings.receiptLogoUrl || DEFAULT_LOGO_PATH;
  if (/^(https?:|data:)/i.test(raw)) return raw;
  return `${apiBaseUrl.replace(/\/+$/, "")}/${raw.replace(/^\/+/, "")}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** pre-wrap without depending on the CSS being honoured by every renderer. */
function escMultiline(s: string): string {
  return esc(s).replace(/\r?\n/g, "<br>");
}

const DIVIDER = `<div class="receipt-divider"></div>`;

function row(label: string, value: string, cls = ""): string {
  return `<div class="receipt-row${cls ? ` ${cls}` : ""}"><span>${label}</span><span class="num">${value}</span></div>`;
}

// ---------------------------------------------------------------------------

/**
 * Build the receipt page. Pure: no I/O, no globals, no `t()` — the labels
 * follow the tenant's receipt language setting, not the cashier's app locale,
 * because the paper goes home with the customer.
 */
export function buildReceiptHtml(
  sale: ReceiptSale,
  settings: ReceiptSettings,
  opts: BuildReceiptOptions,
): string {
  const lang = settings.receiptLanguage;
  const dir = lang === "ar" ? "rtl" : "ltr";
  const shopName = (settings.shopName || "STORE").toUpperCase();
  const shopPhone = settings.shopPhone || "";
  const code = receiptCode(sale);

  const lineDiscountsTotal = sale.lines.reduce((s, l) => s + l.lineDiscountAmount, 0);
  const showLoyalty =
    settings.receiptShowLoyalty &&
    ((sale.loyaltyPointsRedeemed ?? 0) > 0 ||
      (sale.loyaltyCreditApplied ?? 0) > 0 ||
      (sale.loyaltyPointsEarned ?? 0) > 0 ||
      sale.loyaltyPointsBalance !== undefined);

  const items = sale.lines
    .map((line) => {
      let html = `<div class="receipt-row receipt-item-main"><span class="receipt-item-name">${esc(line.productName)}</span><span class="num">${receiptMoney(line.subtotal)}</span></div>`;
      if (line.brand) html += `<div class="receipt-item-sub">${rl("brand", lang)}: ${esc(line.brand)}</div>`;
      if (line.quantity > 1) html += `<div class="receipt-item-sub num">x${line.quantity} @ ${receiptMoney(line.pricePerUnit)}</div>`;
      if (line.lineDiscountAmount > 0) html += `<div class="receipt-item-sub">${rl("discount", lang)} (- ${receiptMoney(line.lineDiscountAmount)})</div>`;
      return html;
    })
    .join("");

  let totals = row(rl("subtotal", lang), receiptMoney(sale.cartSubtotal));
  if (lineDiscountsTotal > 0) totals += row(rl("lineDiscounts", lang), `- ${receiptMoney(lineDiscountsTotal)}`);
  if (sale.orderDiscountAmount > 0) totals += row(rl("orderDiscount", lang), `- ${receiptMoney(sale.orderDiscountAmount)}`);
  if (showLoyalty && (sale.loyaltyPointsRedeemed ?? 0) > 0) totals += row(`${rl("loyaltyPoints", lang)} (×${sale.loyaltyPointsRedeemed})`, "—");
  if (showLoyalty && (sale.loyaltyCreditApplied ?? 0) > 0) totals += row(rl("loyaltyCredit", lang), `- ${receiptMoney(sale.loyaltyCreditApplied ?? 0)}`);
  totals += DIVIDER;
  totals += row(rl("total", lang), receiptMoney(sale.totalPrice), "receipt-total-row");
  if (typeof sale.amountPaid === "number" && sale.amountPaid < sale.totalPrice) {
    totals += row(rl("paid", lang), receiptMoney(sale.amountPaid));
    totals += row(rl("balance", lang), receiptMoney(sale.totalPrice - sale.amountPaid), "receipt-total-row");
  }

  let loyalty = "";
  if (showLoyalty && ((sale.loyaltyPointsEarned ?? 0) > 0 || sale.loyaltyPointsBalance !== undefined)) {
    if ((sale.loyaltyPointsEarned ?? 0) > 0) loyalty += row(rl("loyaltyEarned", lang), `+${sale.loyaltyPointsEarned}`);
    if (sale.loyaltyPointsBalance !== undefined) {
      const credit = sale.loyaltyCreditBalance ? ` · ${receiptMoney(sale.loyaltyCreditBalance)}` : "";
      loyalty += row(rl("walletBalance", lang), `${sale.loyaltyPointsBalance} pt${credit}`);
    }
  }

  const fixed: Record<ReceiptFixedBlock, string> = {
    logo:
      settings.receiptLogoSize !== "hidden" && opts.logoDataUri
        ? `<img class="receipt-logo receipt-logo--${settings.receiptLogoSize}" src="${esc(opts.logoDataUri)}" alt="">`
        : "",
    shopInfo:
      `<div class="receipt-slogan">${esc(shopName)}</div>` +
      (shopPhone ? `<div class="receipt-contact">${rl("tel", lang)}: <span class="num">${esc(shopPhone)}</span></div>` : ""),
    purchaseDate: row(esc(shopName), receiptDate(sale.saleDate)),
    items: `<h1 class="receipt-title">${rl("receipt", lang)}</h1><div class="receipt-items">${items}</div>`,
    totals,
    loyalty,
    footer:
      `<div class="receipt-thankyou">${rl("thankYou", lang)}</div>` +
      (settings.receiptFooterText ? `<div class="receipt-footer">${escMultiline(settings.receiptFooterText)}</div>` : "") +
      `<div class="receipt-eta-notice">إيصال للأغراض التشغيلية — ليس فاتورة ضريبية إلكترونية معتمدة من ETA.</div>` +
      DIVIDER +
      (opts.qrDataUri ? `<div class="receipt-qr"><img class="receipt-qr-img" src="${esc(opts.qrDataUri)}" alt=""></div>` : "") +
      `<div class="receipt-barcode-text num">#${esc(code)}</div>`,
  };

  const blocks: string[] = [];
  const order = settings.receiptBlockOrder?.length ? settings.receiptBlockOrder : DEFAULT_RECEIPT_SETTINGS.receiptBlockOrder;
  for (const key of order) {
    if (key.startsWith("custom:")) {
      const custom = settings.receiptCustomBlocks?.[key.slice(7)];
      if (!custom || !custom.text.trim()) continue;
      blocks.push(`<div class="receipt-custom-block" style="text-align:${esc(custom.align)}" dir="auto">${escMultiline(custom.text)}</div>`);
      continue;
    }
    const html = fixed[key as ReceiptFixedBlock];
    if (html) blocks.push(html);
  }

  const body = blocks.map((b, i) => `<div>${b}${i < blocks.length - 1 ? DIVIDER : ""}</div>`).join("");

  return `<!DOCTYPE html>
<html lang="${lang === "en" ? "en" : "ar"}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${opts.width}mm, initial-scale=1">
<title>${esc(code)}</title>
<style>${receiptCss(opts.width, dir)}</style>
</head>
<body><div class="receipt" dir="${dir}">${body}</div></body>
</html>`;
}

// ---------------------------------------------------------------------------
// CSS — globals.css `.receipt-*` print rules, with the 58mm variant scaled.

function receiptCss(width: ReceiptWidth, dir: "rtl" | "ltr"): string {
  // 80mm roll → 72mm printable (globals.css); 58mm roll → 50mm printable.
  const content = width === 80 ? 72 : 50;
  const scale = width === 80 ? 1 : 0.86;
  const px = (n: number) => `${Math.round(n * scale * 10) / 10}px`;
  const logo = width === 80 ? { small: 18, medium: 32, large: 46 } : { small: 14, medium: 24, large: 34 };
  const qr = width === 80 ? 20 : 16;
  const mono = `'Menlo', 'Consolas', 'Courier New', monospace`;
  const arabic = `system-ui, -apple-system, 'Geeza Pro', 'Noto Naskh Arabic', 'Noto Sans Arabic', 'Arial', sans-serif`;
  const base = dir === "rtl" ? arabic : mono;
  // Under RTL the "sub" indent belongs on the start side.
  const subPad = dir === "rtl" ? "padding-right: 6px;" : "padding-left: 6px;";
  // Tracking pulls Arabic's cursive joins apart, so it is emitted only for
  // Latin labels — the same lang gate the preview applies (`tracked`). The
  // barcode line is always Latin (`#CODE`) and keeps its own spacing.
  const ls = (n: string) => (dir === "ltr" ? ` letter-spacing: ${n};` : "");

  return `
@page { size: ${width}mm auto; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
body { width: ${width}mm; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.receipt {
  width: ${content}mm; margin: 0 auto; padding: 4mm 3mm; box-sizing: content-box;
  font-family: ${base}; font-size: ${px(13)}; line-height: 1.5; color: #000; background: #fff;
  font-weight: 700; direction: ${dir}; word-break: break-word;
}
.num { font-family: ${mono}; font-variant-numeric: tabular-nums; direction: ltr; unicode-bidi: isolate; }
.receipt-logo { display: block; height: auto; object-fit: contain; margin: 0 auto 4px; }
.receipt-logo--small  { width: ${logo.small}mm;  max-height: ${logo.small}mm; }
.receipt-logo--medium { width: ${logo.medium}mm; max-height: ${logo.medium}mm; }
.receipt-logo--large  { width: ${logo.large}mm;  max-height: ${logo.large}mm; }
.receipt-slogan { text-align: center; font-size: ${px(12)};${ls("1px")} text-transform: uppercase; margin: 2px 0; font-weight: 700; }
.receipt-contact { text-align: center; font-size: ${px(11)}; margin: 1px 0;${ls("0.3px")} }
.receipt-title { text-align: center; font-size: ${px(20)}; font-weight: 900;${ls("2px")} margin: 4px 0 6px; text-transform: uppercase; }
.receipt-divider { margin: 4px 0; border-top: 1px solid #000; height: 0; overflow: hidden; }
.receipt-row { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; padding: 1px 0; font-size: ${px(13)}; font-variant-numeric: tabular-nums; }
.receipt-row > span:first-child { flex: 1 1 auto; min-width: 0; }
.receipt-row > span:last-child { flex: 0 0 auto; white-space: nowrap; }
.receipt-items { margin: 2px 0; }
.receipt-item-main { font-weight: 700; }
.receipt-item-name { text-transform: uppercase;${ls("0.5px")} }
.receipt-item-sub { font-size: ${px(12)}; ${subPad} color: #000; }
.receipt-total-row { font-size: ${px(15)}; font-weight: 900;${ls("0.5px")} padding: 2px 0; }
.receipt-thankyou { text-align: center; font-size: ${px(14)}; font-weight: 700;${ls("1px")} margin: 4px 0 2px; text-transform: uppercase; }
.receipt-footer { text-align: center; font-size: ${px(11)}; margin: 4px 0; font-family: ${arabic}; direction: rtl; line-height: 1.5; }
.receipt-custom-block { font-size: ${px(11)}; margin: 4px 0; font-family: ${arabic}; line-height: 1.5; }
.receipt-eta-notice { text-align: center; font-size: ${px(8)}; font-family: ${arabic}; margin: 2px 0; direction: rtl; color: #555; line-height: 1.4; font-weight: 400; }
.receipt-qr { display: flex; justify-content: center; align-items: center; margin: 6px auto 2px; }
.receipt-qr-img { width: ${qr}mm; height: ${qr}mm; image-rendering: pixelated; }
.receipt-barcode-text { text-align: center; font-size: ${px(12)}; letter-spacing: 2px; margin-top: 2px; }
`;
}

// ---------------------------------------------------------------------------
// Page geometry for the PDF — expo-print has no "auto" height, so estimate.

const MM_TO_PT = 72 / 25.4;

/**
 * Characters that fit on one line of a given column before it wraps.
 * Item names are uppercase + letter-spaced in the ~45mm name column (the
 * amount column takes the rest), so they wrap far sooner than the row math
 * suggests; footer / custom text runs the full width at a smaller size.
 */
const CHARS_PER_LINE = {
  80: { name: 20, text: 34 },
  58: { name: 15, text: 25 },
} as const;

/** Lines a block of text occupies once wrapped, counting explicit breaks. */
export function wrappedLines(text: string, charsPerLine: number): number {
  return text
    .split(/\r?\n/)
    .reduce((n, para) => n + Math.max(1, Math.ceil(para.trim().length / charsPerLine)), 0);
}

/**
 * A roll printer cuts where the content ends; a PDF needs a page height up
 * front. Estimate the lines the layout will emit — wrapped, not just rows —
 * and size the page with headroom, so the shared file is a receipt-shaped
 * strip rather than a receipt floating on a Letter sheet. A white tail is
 * harmless; a page break through the totals is not, so the estimate errs long.
 */
export function receiptPageSize(
  sale: ReceiptSale,
  settings: ReceiptSettings,
  opts: BuildReceiptOptions,
): { width: number; height: number } {
  const scale = opts.width === 80 ? 1 : 0.86;
  const lineMm = 6.5 * scale;
  const fit = CHARS_PER_LINE[opts.width];
  let rows = 0;
  rows += 3; // shopInfo + purchaseDate
  rows += 2; // title
  for (const l of sale.lines) {
    rows += wrappedLines(l.productName, fit.name);
    if (l.brand) rows += wrappedLines(l.brand, fit.text);
    if (l.quantity > 1) rows += 1;
    if (l.lineDiscountAmount > 0) rows += 1;
  }
  rows += 4; // subtotal, discounts, total
  if (typeof sale.amountPaid === "number" && sale.amountPaid < sale.totalPrice) rows += 2;
  if (settings.receiptShowLoyalty) rows += 3;
  rows += 4; // thank you + eta + code
  if (settings.receiptFooterText) rows += 1 + wrappedLines(settings.receiptFooterText, fit.text);
  for (const key of settings.receiptBlockOrder ?? []) {
    if (key.startsWith("custom:")) {
      const c = settings.receiptCustomBlocks?.[key.slice(7)];
      if (c?.text.trim()) rows += 1 + wrappedLines(c.text, fit.text);
    }
  }
  const blocks = (settings.receiptBlockOrder ?? DEFAULT_RECEIPT_SETTINGS.receiptBlockOrder).length;
  let heightMm = rows * lineMm + blocks * 3 + 8 /* padding */;
  const logoSize = settings.receiptLogoSize;
  if (opts.logoDataUri && logoSize !== "hidden") {
    const logo = opts.width === 80 ? { small: 18, medium: 32, large: 46 } : { small: 14, medium: 24, large: 34 };
    heightMm += logo[logoSize] + 2;
  }
  if (opts.qrDataUri) heightMm += (opts.width === 80 ? 20 : 16) + 4;
  // 25% headroom: wrapping and font metrics differ per OS renderer, and the
  // cost of over-estimating is blank paper at the bottom of the PDF.
  heightMm = Math.max(heightMm * 1.25, 90);
  return {
    width: Math.round(opts.width * MM_TO_PT),
    height: Math.round(heightMm * MM_TO_PT),
  };
}
