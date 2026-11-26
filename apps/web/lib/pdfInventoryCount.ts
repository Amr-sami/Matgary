// Inventory-count report PDF, A4 portrait, monolingual.
//
// Locale picks the dictionary: "en" → English throughout, "ar" → Arabic
// throughout. The Cairo TTF already shipped for receipts renders both
// scripts, so one font handles both locales. Pagination is manual: when a
// line would overflow the bottom margin, we start a fresh page with the
// same table header. The authoritative reconciliation columns
// (movement, current-at-confirm, expected) are all surfaced so the report
// is reproducible from the numbers it prints.

import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";
// @ts-ignore — fontkit ships without types
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  CountReport,
  CountReportLine,
} from "@/lib/repo/inventory-counts";

export type ReportLocale = "en" | "ar";

export interface InventoryCountPdfInput {
  report: CountReport;
  shopName: string;
  /** EGP by default. Only used for the financial-impact cell. */
  currency?: string;
  /** Final doc title — used by the native share sheet (the backend sends it
   *  as Content-Disposition filename). */
  filename: string;
  /** "en" renders all labels in English, "ar" in Arabic. Product / brand /
   *  category values are passed through as-is: Cairo renders either script. */
  locale?: ReportLocale;
}

// Dictionary per locale. One source of truth — tweaking a label updates
// both header and body references because they look up the same key.
const DICT = {
  en: {
    title: "Inventory Count Report",
    countDate: "Count date",
    scope: "Scope",
    status: "Status",
    created: "Created",
    createdBy: "Created by",
    confirmed: "Confirmed",
    confirmedBy: "Confirmed by",
    scopeSize: "Scope size",
    products: "products",
    statusConfirmed: "Confirmed",
    statusCancelled: "Cancelled",
    statusDraft: "Draft",
    statusInProgress: "In progress",
    statusReview: "Review",
    productsLabel: "Products",
    matched: "Matched",
    shortage: "Shortage",
    overage: "Overage",
    netAdj: "Net adj.",
    financialImpact: "Financial impact",
    breakdown: "Line-by-line breakdown",
    col: {
      name: "Product",
      sku: "SKU",
      base: "Base",
      cnt: "Count",
      mov: "Move",
      cur: "Live",
      exp: "Exp.",
      adj: "Adj.",
      val: "Impact",
    },
    section: {
      shortage: "Shortage",
      overage: "Overage",
      matched: "Matched",
    },
    noLines: "No counted lines in this count.",
    scopeAll: "All products",
    scopeCategory: "Category",
    scopeBrand: "Brand",
    page: "Page",
  },
  ar: {
    title: "تقرير جرد المخزون",
    countDate: "تاريخ الجرد",
    scope: "النطاق",
    status: "الحالة",
    created: "أُنشئ في",
    createdBy: "بواسطة",
    confirmed: "تاريخ الاعتماد",
    confirmedBy: "اعتمده",
    scopeSize: "حجم النطاق",
    products: "منتج",
    statusConfirmed: "مُعتمد",
    statusCancelled: "ملغي",
    statusDraft: "مسودة",
    statusInProgress: "قيد التنفيذ",
    statusReview: "مراجعة",
    productsLabel: "المنتجات",
    matched: "مطابق",
    shortage: "عجز",
    overage: "زيادة",
    netAdj: "الصافي",
    financialImpact: "الأثر المالي",
    breakdown: "التفاصيل سطرًا سطرًا",
    col: {
      name: "المنتج",
      sku: "الكود",
      base: "النظام",
      cnt: "المعدود",
      mov: "حركة",
      cur: "حالي",
      exp: "المتوقع",
      adj: "التعديل",
      val: "الأثر",
    },
    section: {
      shortage: "عجز",
      overage: "زيادة",
      matched: "مطابق",
    },
    noLines: "لا توجد سطور معدودة في هذا الجرد.",
    scopeAll: "كل المنتجات",
    scopeCategory: "التصنيف",
    scopeBrand: "العلامة التجارية",
    page: "صفحة",
  },
} as const;

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 36;
const CONTENT_W = A4.w - MARGIN * 2;

// Column weights (sum to CONTENT_W). Kept as a single array so a column
// rename doesn't desync header and body.
const COLS = [
  { key: "name", w: 148, align: "left" as const },
  { key: "sku", w: 60, align: "left" as const },
  { key: "base", w: 40, align: "right" as const },
  { key: "cnt", w: 40, align: "right" as const },
  { key: "mov", w: 44, align: "right" as const },
  { key: "cur", w: 40, align: "right" as const },
  { key: "exp", w: 44, align: "right" as const },
  { key: "adj", w: 44, align: "right" as const },
  { key: "val", w: 63, align: "right" as const },
];

type ColKey = typeof COLS[number]["key"];

let cachedFontBytes: Uint8Array | null = null;
async function loadCairo(): Promise<Uint8Array> {
  if (cachedFontBytes) return cachedFontBytes;
  const buf = await readFile(
    path.join(process.cwd(), "public", "fonts", "Cairo.ttf"),
  );
  cachedFontBytes = new Uint8Array(buf);
  return cachedFontBytes;
}

let cachedLogoBytes: Uint8Array | null = null;
async function loadLogo(): Promise<Uint8Array | null> {
  if (cachedLogoBytes) return cachedLogoBytes;
  try {
    const buf = await readFile(path.join(process.cwd(), "public", "logo.png"));
    cachedLogoBytes = new Uint8Array(buf);
    return cachedLogoBytes;
  } catch {
    return null;
  }
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtMoney(n: number, currency: string): string {
  const sign = n < 0 ? "−" : n > 0 ? "+" : "";
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${abs} ${currency}`;
}

function fmtAdj(n: number): string {
  if (n === 0) return "0";
  return n > 0 ? `+${fmtInt(n)}` : `−${fmtInt(Math.abs(n))}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (x: number) => x.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDateOnly(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (x: number) => x.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Truncate text to fit `maxW` at `size`, suffixing with "…". pdf-lib has no
 *  shaping API, so we just measure and drop characters from the end. */
function fitText(text: string, font: PDFFont, size: number, maxW: number): string {
  if (!text) return "";
  if (font.widthOfTextAtSize(text, size) <= maxW) return text;
  const ellipsis = "…";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const slice = text.slice(0, mid) + ellipsis;
    if (font.widthOfTextAtSize(slice, size) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ellipsis;
}

export async function generateInventoryCountPdf(
  input: InventoryCountPdfInput,
): Promise<Uint8Array> {
  const currency = input.currency ?? "EGP";
  const locale: ReportLocale = input.locale ?? "en";
  const L = DICT[locale];
  const isRtl = locale === "ar";
  const { report, shopName } = input;

  // Column order mirrors in RTL so the first-read column (product name) is
  // on the right. The weights/alignments stay semantic (a numeric column is
  // still right-aligned regardless of locale).
  const colsOrdered = isRtl ? [...COLS].reverse() : COLS;

  function colByKey(k: ColKey): typeof COLS[number] {
    const found = COLS.find((c) => c.key === k);
    if (!found) throw new Error(`column ${k} missing`);
    return found;
  }

  function statusLabel(s: string): string {
    switch (s) {
      case "completed":
        return L.statusConfirmed;
      case "cancelled":
        return L.statusCancelled;
      case "draft":
        return L.statusDraft;
      case "in_progress":
        return L.statusInProgress;
      case "review":
        return L.statusReview;
      default:
        return s;
    }
  }

  // Scope label from the stored scope: resolved category/brand names come
  // through verbatim (they belong to the tenant's data), but the leading
  // "Category" / "Brand" / "All products" word follows the locale.
  function scopeLabel(): string {
    const { scope } = report.header;
    const value = scope.value?.trim();
    // Pull the trailing display part the repo already appended as
    // "Category: <name>" / "Brand: <name>". We re-prefix with the local word.
    if (scope.kind === "all") return L.scopeAll;
    // If the repo added a readable name, prefer the last "value" bit.
    const serverLabel = report.header.scopeLabel;
    const maybeName = serverLabel.includes(":")
      ? serverLabel.split(":").slice(1).join(":").trim()
      : value ?? "";
    const prefix = scope.kind === "category" ? L.scopeCategory : L.scopeBrand;
    return maybeName ? `${prefix}: ${maybeName}` : prefix;
  }

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(input.filename.replace(/\.pdf$/i, ""));
  pdf.setCreator("Storo");
  pdf.setProducer("Storo · Inventory Count");

  const cairoBytes = await loadCairo();
  const body = await pdf.embedFont(cairoBytes, { subset: true });
  const bodyBold = await pdf.embedFont(cairoBytes, { subset: true }); // same TTF; emphasis via size
  const mono = await pdf.embedFont(StandardFonts.Courier);

  // Palette
  const TEXT = rgb(0.078, 0.102, 0.141);
  const MUTED = rgb(0.45, 0.48, 0.55);
  const BORDER = rgb(0.88, 0.89, 0.92);
  const BG_TINT = rgb(0.96, 0.97, 0.99);
  const ACCENT = rgb(0.0, 0.47, 0.88);
  const DANGER = rgb(0.86, 0.15, 0.17);
  const SUCCESS = rgb(0.0, 0.5, 0.24);

  // Page cursor shared across helpers.
  let page: PDFPage = pdf.addPage([A4.w, A4.h]);
  let y = A4.h - MARGIN;
  let pageNumber = 1;

  function newPage(): void {
    page = pdf.addPage([A4.w, A4.h]);
    y = A4.h - MARGIN;
    pageNumber += 1;
    drawPageHeader();
  }

  function ensureSpace(h: number): void {
    if (y - h < MARGIN + 28) {
      drawTableHeader();
      newPage();
      drawTableHeader();
    }
  }

  function drawText(
    text: string,
    x: number,
    yPos: number,
    opts: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> } = {},
  ): void {
    page.drawText(text, {
      x,
      y: yPos,
      size: opts.size ?? 10,
      font: opts.font ?? body,
      color: opts.color ?? TEXT,
    });
  }

  function drawRightText(
    text: string,
    rightX: number,
    yPos: number,
    opts: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> } = {},
  ): void {
    const f = opts.font ?? mono;
    const s = opts.size ?? 10;
    const w = f.widthOfTextAtSize(text, s);
    page.drawText(text, {
      x: rightX - w,
      y: yPos,
      size: s,
      font: f,
      color: opts.color ?? TEXT,
    });
  }

  function drawDivider(): void {
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: A4.w - MARGIN, y },
      thickness: 0.5,
      color: BORDER,
    });
    y -= 10;
  }

  function drawPageHeader(): void {
    if (pageNumber === 1) return;
    const refStr = `${report.header.ref} · ${shopName}`;
    const pageLabel = `${L.page} ${pageNumber}`;
    const refW = body.widthOfTextAtSize(refStr, 9);
    const pageW = body.widthOfTextAtSize(pageLabel, 9);
    if (isRtl) {
      page.drawText(refStr, {
        x: A4.w - MARGIN - refW,
        y,
        size: 9,
        font: body,
        color: MUTED,
      });
      page.drawText(pageLabel, { x: MARGIN, y, size: 9, font: body, color: MUTED });
    } else {
      page.drawText(refStr, { x: MARGIN, y, size: 9, font: body, color: MUTED });
      page.drawText(pageLabel, {
        x: A4.w - MARGIN - pageW,
        y,
        size: 9,
        font: body,
        color: MUTED,
      });
    }
    y -= 14;
    drawDivider();
  }

  // ── Top cover block (first page only) ─────────────────────────────────────
  // In LTR: logo on the left, shop name + ref on the right.
  // In RTL (Arabic): mirror — logo on the right, shop name + ref on the left.
  const logo = await loadLogo();
  const LOGO_H = 40;
  if (logo) {
    try {
      const img = await pdf.embedPng(logo);
      const w = (img.width / img.height) * LOGO_H;
      page.drawImage(img, {
        x: isRtl ? A4.w - MARGIN - w : MARGIN,
        y: y - LOGO_H,
        width: w,
        height: LOGO_H,
      });
    } catch {
      // ignore
    }
  }
  {
    const shopW = body.widthOfTextAtSize(shopName, 13);
    const refW = body.widthOfTextAtSize(report.header.ref, 11);
    const shopX = isRtl ? MARGIN : A4.w - MARGIN - shopW;
    const refX = isRtl ? MARGIN : A4.w - MARGIN - refW;
    page.drawText(shopName, { x: shopX, y: y - 14, size: 13, font: bodyBold, color: TEXT });
    page.drawText(report.header.ref, { x: refX, y: y - 30, size: 11, font: body, color: ACCENT });
  }
  y -= 52;

  // Title — right-aligned in RTL.
  {
    const titleW = bodyBold.widthOfTextAtSize(L.title, 20);
    drawText(
      L.title,
      isRtl ? A4.w - MARGIN - titleW : MARGIN,
      y - 18,
      { font: bodyBold, size: 20 },
    );
  }
  y -= 24;
  drawDivider();

  // ── Metadata card ─────────────────────────────────────────────────────────
  const countDate =
    report.header.status === "completed"
      ? report.header.confirmedAt
      : report.header.createdAt;
  const metaRows: Array<[string, string]> = [
    [L.countDate, fmtDateOnly(countDate)],
    [L.scope, scopeLabel()],
    [L.status, statusLabel(report.header.status)],
    [L.created, fmtDate(report.header.createdAt)],
    [L.createdBy, report.header.createdByName ?? "—"],
    [
      L.confirmed,
      report.header.confirmedAt ? fmtDate(report.header.confirmedAt) : "—",
    ],
    [L.confirmedBy, report.header.confirmedByName ?? "—"],
    [
      L.scopeSize,
      `${fmtInt(report.header.scopeProductCount)} ${L.products}`,
    ],
  ];

  // Two-column grid: 4 rows × 2 cells. In RTL, each cell's text aligns to
  // the cell's right edge; column order is also reversed so the first
  // logical row (Count date / Scope) sits on the right.
  const META_CELL_W = (CONTENT_W - 12) / 2;
  const META_ROW_H = 30;
  const metaCardH = META_ROW_H * Math.ceil(metaRows.length / 2) + 12;
  page.drawRectangle({
    x: MARGIN,
    y: y - metaCardH,
    width: CONTENT_W,
    height: metaCardH,
    borderColor: BORDER,
    borderWidth: 0.6,
    color: BG_TINT,
  });
  for (let i = 0; i < metaRows.length; i += 1) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const visualCol = isRtl ? 1 - col : col;
    const cellLeft = MARGIN + 8 + visualCol * (META_CELL_W + 4);
    const cellRight = cellLeft + META_CELL_W - 8;
    const cellY = y - 8 - row * META_ROW_H;
    const [label, value] = metaRows[i];
    const fitted = fitText(value, body, 11, META_CELL_W - 12);
    if (isRtl) {
      const lw = body.widthOfTextAtSize(label, 8);
      const vw = bodyBold.widthOfTextAtSize(fitted, 11);
      drawText(label, cellRight - lw, cellY - 10, { size: 8, color: MUTED });
      drawText(fitted, cellRight - vw, cellY - 22, { size: 11, font: bodyBold });
    } else {
      drawText(label, cellLeft, cellY - 10, { size: 8, color: MUTED });
      drawText(fitted, cellLeft, cellY - 22, { size: 11, font: bodyBold });
    }
  }
  y -= metaCardH + 14;

  // ── Summary: 5-cell StatCard-style row ────────────────────────────────────
  const stats: Array<{
    label: string;
    value: string;
    color?: ReturnType<typeof rgb>;
  }> = [
    { label: L.productsLabel, value: fmtInt(report.summary.linesTotal) },
    {
      label: L.matched,
      value: fmtInt(report.summary.linesMatched),
      color: TEXT,
    },
    {
      label: L.shortage,
      value: fmtInt(report.summary.linesShortage),
      color: DANGER,
    },
    {
      label: L.overage,
      value: fmtInt(report.summary.linesOverage),
      color: SUCCESS,
    },
    {
      label: L.netAdj,
      value: fmtAdj(report.summary.netAdjustment),
      color:
        report.summary.netAdjustment < 0
          ? DANGER
          : report.summary.netAdjustment > 0
            ? SUCCESS
            : TEXT,
    },
  ];
  const STAT_W = (CONTENT_W - 4 * 8) / 5;
  const STAT_H = 56;
  for (let i = 0; i < stats.length; i += 1) {
    const s = stats[i];
    const visualIdx = isRtl ? stats.length - 1 - i : i;
    const x = MARGIN + visualIdx * (STAT_W + 8);
    page.drawRectangle({
      x,
      y: y - STAT_H,
      width: STAT_W,
      height: STAT_H,
      borderColor: BORDER,
      borderWidth: 0.6,
      color: rgb(1, 1, 1),
    });
    if (isRtl) {
      const lw = body.widthOfTextAtSize(s.label, 8);
      const vw = bodyBold.widthOfTextAtSize(s.value, 18);
      drawText(s.label, x + STAT_W - 8 - lw, y - 16, { size: 8, color: MUTED });
      drawText(s.value, x + STAT_W - 8 - vw, y - 40, {
        size: 18,
        font: bodyBold,
        color: s.color ?? TEXT,
      });
    } else {
      drawText(s.label, x + 8, y - 16, { size: 8, color: MUTED });
      drawText(s.value, x + 8, y - 40, {
        size: 18,
        font: bodyBold,
        color: s.color ?? TEXT,
      });
    }
  }
  y -= STAT_H + 10;

  if (report.summary.financialImpact != null) {
    const imp = report.summary.financialImpact;
    const label = L.financialImpact;
    const value = fmtMoney(imp, currency);
    const color = imp < 0 ? DANGER : imp > 0 ? SUCCESS : TEXT;
    page.drawRectangle({
      x: MARGIN,
      y: y - 32,
      width: CONTENT_W,
      height: 32,
      borderColor: BORDER,
      borderWidth: 0.6,
      color: BG_TINT,
    });
    const vw = bodyBold.widthOfTextAtSize(value, 14);
    if (isRtl) {
      const lw = body.widthOfTextAtSize(label, 10);
      drawText(label, A4.w - MARGIN - 8 - lw, y - 20, { size: 10, color: MUTED });
      page.drawText(value, { x: MARGIN + 8, y: y - 22, size: 14, font: bodyBold, color });
    } else {
      drawText(label, MARGIN + 8, y - 20, { size: 10, color: MUTED });
      page.drawText(value, {
        x: A4.w - MARGIN - 8 - vw,
        y: y - 22,
        size: 14,
        font: bodyBold,
        color,
      });
    }
    y -= 40;
  } else {
    y -= 4;
  }

  // ── Detail table ──────────────────────────────────────────────────────────
  {
    const bw = bodyBold.widthOfTextAtSize(L.breakdown, 12);
    drawText(
      L.breakdown,
      isRtl ? A4.w - MARGIN - bw : MARGIN,
      y - 14,
      { size: 12, font: bodyBold },
    );
  }
  y -= 22;

  const labelMap: Record<ColKey, string> = L.col;

  function drawTableHeader(): void {
    page.drawRectangle({
      x: MARGIN,
      y: y - 18,
      width: CONTENT_W,
      height: 18,
      color: BG_TINT,
    });
    let cx = MARGIN + 4;
    for (const col of colsOrdered) {
      const label = labelMap[col.key as ColKey];
      // Textual columns hug the start-of-reading edge; numeric columns hug
      // the end-of-cell edge. "start" flips with locale.
      const alignToStart = col.align === "left";
      const startIsLeftEdge = (alignToStart && !isRtl) || (!alignToStart && isRtl);
      if (startIsLeftEdge) {
        drawText(label, cx, y - 13, { size: 8, color: MUTED });
      } else {
        drawRightText(label, cx + col.w - 4, y - 13, { size: 8, color: MUTED, font: body });
      }
      cx += col.w;
    }
    y -= 20;
  }

  drawTableHeader();

  // Order: shortage (negative adj) → overage (positive) → matched. The repo
  // already sorts rows by (adjustment ASC, name ASC); we just re-group by
  // partition so the section headers show up in the right places.
  const shortage = report.lines.filter((l) => l.adjustment < 0);
  const overage = report.lines.filter((l) => l.adjustment > 0);
  const matched = report.lines.filter((l) => l.adjustment === 0);

  function drawSectionBreak(title: string, color: ReturnType<typeof rgb>): void {
    ensureSpace(22);
    page.drawRectangle({
      x: MARGIN,
      y: y - 16,
      width: CONTENT_W,
      height: 16,
      color,
      opacity: 0.08,
    });
    if (isRtl) {
      const tw = bodyBold.widthOfTextAtSize(title, 9);
      drawText(title, A4.w - MARGIN - 6 - tw, y - 12, { size: 9, font: bodyBold, color });
    } else {
      drawText(title, MARGIN + 6, y - 12, { size: 9, font: bodyBold, color });
    }
    y -= 20;
  }

  function drawLine(l: CountReportLine): void {
    ensureSpace(18);

    // Zebra stripe
    if ((pageNumber * 1000 + Math.round(y)) % 2 === 0) {
      page.drawRectangle({
        x: MARGIN,
        y: y - 18,
        width: CONTENT_W,
        height: 18,
        color: BG_TINT,
        opacity: 0.4,
      });
    }

    const yText = y - 13;
    const colorForAdj =
      l.adjustment === 0 ? TEXT : l.adjustment < 0 ? DANGER : SUCCESS;

    // Cell values indexed by COLS semantic key, built once.
    const cellByKey: Record<ColKey, { text: string; font?: PDFFont; color?: ReturnType<typeof rgb>; maxW?: number }> = {
      name: {
        text: l.productName + (l.addedMidCount ? "  *" : ""),
        maxW: colByKey("name").w - 8,
      },
      sku: { text: l.productSku ?? "", color: MUTED, maxW: colByKey("sku").w - 4 },
      base: { text: fmtInt(l.baselineQty) },
      cnt: { text: fmtInt(l.countedQty) },
      mov: {
        text: fmtAdj(l.movementAfterCount),
        color: l.movementAfterCount === 0 ? MUTED : TEXT,
      },
      cur: { text: fmtInt(l.currentQtyAtConfirm) },
      exp: { text: fmtInt(l.expectedPhysical) },
      adj: { text: fmtAdj(l.adjustment), font: mono, color: colorForAdj },
      val: l.valueImpact != null
        ? { text: fmtMoney(l.valueImpact, currency), font: mono, color: colorForAdj }
        : { text: "—", color: MUTED },
    };

    let cx = MARGIN + 4;
    for (const col of colsOrdered) {
      const cell = cellByKey[col.key as ColKey];
      const alignToStart = col.align === "left";
      const startIsLeftEdge = (alignToStart && !isRtl) || (!alignToStart && isRtl);
      const fitted = cell.maxW
        ? fitText(cell.text, cell.font ?? body, 9, cell.maxW)
        : cell.text;
      if (startIsLeftEdge) {
        drawText(fitted, cx, yText, { size: 9, font: cell.font, color: cell.color });
      } else {
        drawRightText(fitted, cx + col.w - 4, yText, {
          size: 9,
          font: cell.font ?? body,
          color: cell.color,
        });
      }
      cx += col.w;
    }

    y -= 16;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: A4.w - MARGIN, y },
      thickness: 0.3,
      color: BORDER,
    });
    y -= 2;
  }

  if (shortage.length > 0) {
    drawSectionBreak(`${L.section.shortage} · ${shortage.length}`, DANGER);
    for (const l of shortage) drawLine(l);
  }
  if (overage.length > 0) {
    drawSectionBreak(`${L.section.overage} · ${overage.length}`, SUCCESS);
    for (const l of overage) drawLine(l);
  }
  if (matched.length > 0) {
    drawSectionBreak(`${L.section.matched} · ${matched.length}`, MUTED);
    for (const l of matched) drawLine(l);
  }

  if (report.lines.length === 0) {
    y -= 8;
    if (isRtl) {
      const w = body.widthOfTextAtSize(L.noLines, 10);
      drawText(L.noLines, A4.w - MARGIN - w, y - 14, { size: 10, color: MUTED });
    } else {
      drawText(L.noLines, MARGIN, y - 14, { size: 10, color: MUTED });
    }
    y -= 18;
  }

  // ── Footer on every page ──────────────────────────────────────────────────
  const pageCount = pdf.getPageCount();
  const generatedAt = new Date().toISOString();
  for (let i = 0; i < pageCount; i += 1) {
    const p = pdf.getPage(i);
    const footY = MARGIN - 10;
    p.drawLine({
      start: { x: MARGIN, y: MARGIN + 4 },
      end: { x: A4.w - MARGIN, y: MARGIN + 4 },
      thickness: 0.4,
      color: BORDER,
    });
    const refLine = `${report.header.ref} · ${fmtDate(generatedAt)}`;
    const pageLine = `${L.page} ${i + 1} / ${pageCount}`;
    const refW = body.widthOfTextAtSize(refLine, 8);
    const pageW = body.widthOfTextAtSize(pageLine, 8);
    if (isRtl) {
      p.drawText(refLine, { x: A4.w - MARGIN - refW, y: footY, size: 8, font: body, color: MUTED });
      p.drawText(pageLine, { x: MARGIN, y: footY, size: 8, font: body, color: MUTED });
    } else {
      p.drawText(refLine, { x: MARGIN, y: footY, size: 8, font: body, color: MUTED });
      p.drawText(pageLine, {
        x: A4.w - MARGIN - pageW,
        y: footY,
        size: 8,
        font: body,
        color: MUTED,
      });
    }
  }

  return pdf.save();
}

/** Build the on-disk filename the share-sheet should surface:
 *  Storo_Inventory_Count_<ref>_<YYYY-MM-DD>.pdf */
export function inventoryCountPdfFilename(report: CountReport): string {
  const refSafe = report.header.ref.replace(/[^A-Z0-9-]/gi, "");
  const d = new Date(
    report.header.status === "completed"
      ? (report.header.confirmedAt ?? report.header.createdAt)
      : report.header.createdAt,
  );
  const pad = (x: number) => x.toString().padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `Storo_Inventory_Count_${refSafe}_${date}.pdf`;
}
