// Ticket model → ESC/POS bytes. Pure TS (doc 06 §1.4 "layout.ts" + raster).
//
// Two independent paths share one ticket model:
//  - textReceipt(): the printer's own font, 32 cols (58mm) / 48 cols (80mm).
//    Reliable for Latin and digits; Arabic only on printers with a PC864 font.
//  - receiptToRasterCommands(): a 1-bit bitmap (384 px for 58mm, 576 px for
//    80mm) blitted with GS v 0. Whatever rendered the bitmap did the Arabic
//    shaping, so this is the path that works on every printer.

import {
  type Align,
  type CodeTableNumbering,
  align,
  bold,
  codepage as selectCodepage,
  charsetUsa,
  concat,
  cut,
  feed,
  init,
  latin1Bytes,
  newline,
  qrCode,
  rasterImage,
  size,
} from "./commands";
import { type Codepage, cellWidth, encodeText, hasArabic, toVisual } from "./encode";

export type PaperWidth = 58 | 80;

/** Printable columns in font A. */
export const COLUMNS: Record<PaperWidth, number> = { 58: 32, 80: 48 };
/** Printable dots per line — the raster width. */
export const DOTS: Record<PaperWidth, number> = { 58: 384, 80: 576 };

export type TicketLine =
  | { kind: "text"; text: string; align?: Align; bold?: boolean; size?: 1 | 2 }
  | { kind: "row"; start: string; end: string; bold?: boolean }
  | { kind: "rule"; char?: string }
  | { kind: "feed"; lines: number }
  | { kind: "qr"; data: string }
  | { kind: "cut" };

export interface Ticket {
  /** Reading direction of the ticket — decides which side `row.start` sits on. */
  rtl: boolean;
  lines: TicketLine[];
}

// ---------------------------------------------------------------------------
// Text path

export interface TextReceiptOptions {
  width: PaperWidth;
  /** Code table for non-ASCII. pc864 is the one that shapes Arabic. Default pc864 when the ticket has Arabic, else pc437. */
  codepage?: Codepage;
  /** Skip the final cut (58mm printers without a cutter). Default true. */
  cut?: boolean;
  /** Whose ESC t numbering the printer's firmware uses. Default "epson"; Xprinter/GOOJPRT clones want "xprinter". */
  numbering?: CodeTableNumbering;
}

/** Truncate to `n` cells, appending nothing — receipts have no room for an ellipsis. */
export function fit(text: string, n: number): string {
  if (cellWidth(text) <= n) return text;
  const chars = Array.from(text);
  let out = "";
  for (const c of chars) {
    if (cellWidth(out + c) > n) break;
    out += c;
  }
  return out;
}

/**
 * Lay out a two-column row. `start` is the reading-order start (item name),
 * `end` the reading-order end (amount). Under RTL the visual line is
 * `end … start`, so the amount lands on the left edge where the printer's
 * left-to-right motion puts it, and the name hugs the right edge — on every
 * row of the ticket, whether or not the name happens to contain Arabic.
 *
 * The result is VISUAL: `cell` turns each cell into its own visual paragraph
 * (see toVisual) after `start` is truncated in logical order, so the line
 * must be encoded with `raw: true` — running visualOrder on it again would
 * flip the amount to the other edge on Arabic rows only.
 */
export function rowText(start: string, end: string, cols: number, rtl: boolean, cell: (s: string) => string = (s) => s): string {
  const endV = cell(end);
  const endW = cellWidth(endV);
  const room = Math.max(1, cols - endW - 1);
  const startV = cell(fit(start, room));
  const gap = " ".repeat(Math.max(1, cols - cellWidth(startV) - endW));
  return rtl ? `${endV}${gap}${startV}` : `${startV}${gap}${endV}`;
}

/** Wrap a paragraph on spaces at `cols` cells. */
export function wrap(text: string, cols: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (cellWidth(candidate) <= cols) cur = candidate;
    else {
      if (cur) lines.push(cur);
      cur = cellWidth(w) > cols ? fit(w, cols) : w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function ticketHasArabic(ticket: Ticket): boolean {
  return ticket.lines.some((l) =>
    l.kind === "text" ? hasArabic(l.text) : l.kind === "row" ? hasArabic(l.start) || hasArabic(l.end) : false,
  );
}

/**
 * Render a ticket with the printer's own font. Text lines are one logical
 * paragraph each (encodeText shapes and reorders them); rows are laid out
 * visually cell by cell and sent raw so the amount column stays on one edge.
 */
export function textReceipt(ticket: Ticket, opts: TextReceiptOptions): Uint8Array {
  const cols = COLUMNS[opts.width];
  const cp: Codepage = opts.codepage ?? (ticketHasArabic(ticket) ? "pc864" : "pc437");
  const parts: Uint8Array[] = [init(), charsetUsa(), selectCodepage(cp, opts.numbering)];
  const line = (s: string) => parts.push(encodeText(s, cp), newline());
  const cell = (s: string) => toVisual(s, cp);

  for (const l of ticket.lines) {
    switch (l.kind) {
      case "text": {
        const a: Align = l.align ?? (ticket.rtl ? "right" : "left");
        const scale = l.size ?? 1;
        parts.push(align(a), bold(!!l.bold), size(scale));
        for (const w of wrap(l.text, Math.floor(cols / scale))) line(w);
        parts.push(size(1), bold(false));
        break;
      }
      case "row":
        parts.push(align("left"), bold(!!l.bold));
        parts.push(encodeText(rowText(l.start, l.end, cols, ticket.rtl, cell), cp, { raw: true }), newline());
        parts.push(bold(false));
        break;
      case "rule":
        parts.push(align("left"));
        line((l.char ?? "-").repeat(cols));
        break;
      case "feed":
        parts.push(feed(l.lines));
        break;
      case "qr":
        parts.push(align("center"), qrCode(l.data, opts.width === 58 ? 4 : 6), newline());
        break;
      case "cut":
        if (opts.cut !== false) parts.push(cut(true, 3));
        break;
    }
  }
  return concat(...parts);
}

// ---------------------------------------------------------------------------
// Raster path

export interface Bitmap1 {
  /** Pixels per row — must be a multiple of 8 (384 or 576 for receipts). */
  width: number;
  height: number;
  /** Packed rows, MSB first, 1 = black; length = width/8 * height. */
  data: Uint8Array;
}

/** 8-bit grey (or luma) → packed 1-bit, `threshold` and below prints black. */
export function packGray(gray: Uint8Array, width: number, height: number, threshold = 128): Bitmap1 {
  if (width % 8 !== 0) throw new RangeError("packGray: width must be a multiple of 8");
  const bpr = width / 8;
  const data = new Uint8Array(bpr * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((gray[y * width + x] ?? 255) <= threshold) data[y * bpr + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return { width, height, data };
}

/**
 * Full ticket from a bitmap: init, the image in ≤ `sliceRows`-row GS v 0
 * slices (clone firmware drops bytes on tall images), a feed and a cut.
 */
export function receiptToRasterCommands(bitmap: Bitmap1, opts: { cut?: boolean; feedAfter?: number; sliceRows?: number } = {}): Uint8Array {
  if (bitmap.width % 8 !== 0) throw new RangeError("raster: width must be a multiple of 8");
  const bpr = bitmap.width / 8;
  if (bitmap.data.length !== bpr * bitmap.height) throw new RangeError("raster: data length does not match width × height");
  const slice = Math.max(8, Math.min(255, opts.sliceRows ?? 128));
  const parts: Uint8Array[] = [init(), align("left")];
  for (let y = 0; y < bitmap.height; y += slice) {
    const rows = Math.min(slice, bitmap.height - y);
    parts.push(rasterImage(bitmap.data.subarray(y * bpr, (y + rows) * bpr), bpr, rows));
  }
  parts.push(feed(opts.feedAfter ?? 3));
  if (opts.cut !== false) parts.push(cut(true, 0));
  return concat(...parts);
}

// ---------------------------------------------------------------------------
// Sale → ticket

/** The slice of a sale the ticket needs — structurally satisfied by the app's ReceiptSale. */
export interface TicketSale {
  invoiceId: string;
  saleDate: Date;
  lines: { productName: string; brand?: string | null; quantity: number; pricePerUnit: number; subtotal: number; lineDiscountAmount: number }[];
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

export interface TicketShop {
  shopName: string;
  shopPhone?: string;
  footerText?: string;
  showLoyalty?: boolean;
  /** Payload for the QR at the bottom (the web puts the invoice URL there). */
  qrPayload?: string;
}

export type TicketLanguage = "ar" | "en" | "bilingual";

const L = {
  receipt: { en: "RECEIPT", ar: "فاتورة" },
  invoice: { en: "Invoice", ar: "رقم الفاتورة" },
  date: { en: "Date", ar: "التاريخ" },
  item: { en: "Item", ar: "الصنف" },
  subtotal: { en: "Subtotal", ar: "المجموع" },
  lineDiscounts: { en: "Line discounts", ar: "خصومات الأصناف" },
  orderDiscount: { en: "Order discount", ar: "خصم الفاتورة" },
  discount: { en: "Discount", ar: "خصم" },
  loyaltyPoints: { en: "Points redeemed", ar: "نقاط مستخدمة" },
  loyaltyCredit: { en: "Credit applied", ar: "رصيد مستخدم" },
  total: { en: "TOTAL", ar: "الإجمالي" },
  paid: { en: "Paid", ar: "المدفوع" },
  change: { en: "Change", ar: "الباقي" },
  loyaltyEarned: { en: "Points earned", ar: "نقاط مكتسبة" },
  pointsBalance: { en: "Points balance", ar: "رصيد النقاط" },
  walletBalance: { en: "Wallet balance", ar: "رصيد المحفظة" },
  thanks: { en: "Thank you!", ar: "شكراً لزيارتكم" },
} as const;

function label(key: keyof typeof L, lang: TicketLanguage): string {
  const e = L[key];
  return lang === "ar" ? e.ar : lang === "en" ? e.en : `${e.ar} / ${e.en}`;
}

/** 1234.5 → "1,234.50" — no Intl (Hermes has no ICU). */
export function ticketMoney(n: number): string {
  const neg = n < 0;
  const [int, frac] = Math.abs(n).toFixed(2).split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}.${frac}`;
}

const p2 = (n: number) => String(n).padStart(2, "0");
export function ticketDate(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** Build the ticket the web's Receipt.tsx would print, block for block. */
export function saleToTicket(sale: TicketSale, shop: TicketShop, language: TicketLanguage = "ar"): Ticket {
  const rtl = language !== "en";
  const lines: TicketLine[] = [];
  const text = (t: string, o: Partial<Extract<TicketLine, { kind: "text" }>> = {}) => lines.push({ kind: "text", text: t, ...o });
  const row = (start: string, end: string, b = false) => lines.push({ kind: "row", start, end, bold: b });
  const rule = () => lines.push({ kind: "rule" });

  text(shop.shopName || "STORE", { align: "center", bold: true, size: 2 });
  if (shop.shopPhone) text(shop.shopPhone, { align: "center" });
  text(`*** ${label("receipt", language)} ***`, { align: "center", bold: true });
  row(label("invoice", language), sale.invoiceId);
  row(label("date", language), ticketDate(sale.saleDate));
  rule();

  for (const l of sale.lines) {
    const name = l.brand ? `${l.productName} - ${l.brand}` : l.productName;
    text(name, { align: rtl ? "right" : "left" });
    const gross = l.subtotal + (l.lineDiscountAmount || 0);
    row(`${l.quantity} x ${ticketMoney(l.pricePerUnit)}`, ticketMoney(gross));
    if (l.lineDiscountAmount > 0) row(`  ${label("discount", language)}`, `-${ticketMoney(l.lineDiscountAmount)}`);
  }
  rule();

  const lineDiscounts = sale.lines.reduce((s, l) => s + (l.lineDiscountAmount || 0), 0);
  row(label("subtotal", language), ticketMoney(sale.cartSubtotal));
  if (lineDiscounts > 0) row(label("lineDiscounts", language), `-${ticketMoney(lineDiscounts)}`);
  if (sale.orderDiscountAmount > 0) row(label("orderDiscount", language), `-${ticketMoney(sale.orderDiscountAmount)}`);
  if (sale.loyaltyPointsRedeemed) row(label("loyaltyPoints", language), String(sale.loyaltyPointsRedeemed));
  if (sale.loyaltyCreditApplied) row(label("loyaltyCredit", language), `-${ticketMoney(sale.loyaltyCreditApplied)}`);
  row(label("total", language), ticketMoney(sale.totalPrice), true);
  if (sale.amountPaid !== undefined && sale.amountPaid > 0) {
    row(label("paid", language), ticketMoney(sale.amountPaid));
    const change = sale.amountPaid - sale.totalPrice;
    if (change > 0.004) row(label("change", language), ticketMoney(change));
  }

  if (shop.showLoyalty !== false && (sale.loyaltyPointsEarned || sale.loyaltyPointsBalance !== undefined || sale.loyaltyCreditBalance)) {
    rule();
    if (sale.loyaltyPointsEarned) row(label("loyaltyEarned", language), String(sale.loyaltyPointsEarned));
    if (sale.loyaltyPointsBalance !== undefined) row(label("pointsBalance", language), String(sale.loyaltyPointsBalance));
    if (sale.loyaltyCreditBalance) row(label("walletBalance", language), ticketMoney(sale.loyaltyCreditBalance));
  }

  rule();
  text(shop.footerText?.trim() || label("thanks", language), { align: "center" });
  if (shop.qrPayload) lines.push({ kind: "qr", data: shop.qrPayload });
  lines.push({ kind: "feed", lines: 3 }, { kind: "cut" });
  return { rtl, lines };
}

/** The short ticket the settings screen sends on "Test print". */
export function testTicket(printerName: string, width: PaperWidth): Ticket {
  return {
    rtl: false,
    lines: [
      { kind: "text", text: "TheStoro", align: "center", bold: true, size: 2 },
      { kind: "text", text: "Printer test / اختبار الطابعة", align: "center" },
      { kind: "rule" },
      { kind: "row", start: "Printer", end: fit(printerName, 20) },
      { kind: "row", start: "Paper", end: `${width} mm / ${COLUMNS[width]} cols` },
      { kind: "row", start: "Time", end: ticketDate(new Date()) },
      { kind: "rule" },
      { kind: "text", text: "1234567890 ABCDEFGHIJ abcdefghij", align: "left" },
      { kind: "text", text: "شكراً لزيارتكم", align: "center" },
      { kind: "feed", lines: 3 },
      { kind: "cut" },
    ],
  };
}

/** Bytes for a plain ASCII string with a trailing newline — handy for probes. */
export const asciiLine = (s: string): Uint8Array => concat(latin1Bytes(s), newline());
