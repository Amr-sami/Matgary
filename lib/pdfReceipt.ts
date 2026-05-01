import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
// @ts-ignore — fontkit ships without types
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface PdfInvoiceLine {
  productName: string;
  brand?: string;
  quantity: number;
  pricePerUnit: number;
  subtotal: number;
  lineDiscountAmount: number;
}

export interface PdfInvoiceData {
  invoiceId: string;
  saleDate: string; // ISO
  customerName?: string;
  customerPhone?: string;
  lines: PdfInvoiceLine[];
  cartSubtotal: number;
  orderDiscountAmount: number;
  totalPrice: number;
  note?: string;
  shopName: string;
  shopPhone: string;
}

const PT_PER_MM = 2.83465;
const WIDTH_MM = 80;
const PAD_MM = 4;

const PAGE_W = WIDTH_MM * PT_PER_MM;
const PAD = PAD_MM * PT_PER_MM;
const CONTENT_W = PAGE_W - PAD * 2;

function fmtMoney(n: number): string {
  return `${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} EGP`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours() % 12 || 12)}:${pad(d.getMinutes())} ${d.getHours() >= 12 ? "PM" : "AM"}`;
}

let cachedFontBytes: Uint8Array | null = null;
async function loadCairoFont(): Promise<Uint8Array> {
  if (cachedFontBytes) return cachedFontBytes;
  const p = path.join(process.cwd(), "public", "fonts", "Cairo.ttf");
  const buf = await readFile(p);
  cachedFontBytes = new Uint8Array(buf);
  return cachedFontBytes;
}

let cachedLogoBytes: Uint8Array | null = null;
async function loadLogo(): Promise<Uint8Array | null> {
  if (cachedLogoBytes) return cachedLogoBytes;
  try {
    const p = path.join(process.cwd(), "public", "logo.png");
    const buf = await readFile(p);
    cachedLogoBytes = new Uint8Array(buf);
    return cachedLogoBytes;
  } catch {
    return null;
  }
}

export async function generateReceiptPdf(data: PdfInvoiceData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const cairoBytes = await loadCairoFont();
  const arabicFont = await pdf.embedFont(cairoBytes, { subset: true });
  const monoFont = await pdf.embedFont(StandardFonts.Courier);
  const monoBoldFont = await pdf.embedFont(StandardFonts.CourierBold);

  // Two-pass approach: first measure required height
  let estHeight = PAD; // top
  estHeight += 60; // logo space
  estHeight += 14 * 4; // header lines
  estHeight += 8;
  estHeight += 2; // divider
  estHeight += 22; // RECEIPT title
  estHeight += 14; // date
  estHeight += 8;
  estHeight += 2;
  for (const line of data.lines) {
    estHeight += 14;
    if (line.brand) estHeight += 12;
    if (line.quantity > 1) estHeight += 12;
    if (line.lineDiscountAmount > 0) estHeight += 12;
  }
  estHeight += 8;
  estHeight += 2;
  estHeight += 14 * 3;
  estHeight += 2;
  estHeight += 22; // total
  estHeight += 2;
  estHeight += 14 * 2;
  if (data.customerName || data.customerPhone) estHeight += 14 * 2;
  estHeight += PAD;

  const pageHeight = Math.max(estHeight, 200);
  const page = pdf.addPage([PAGE_W, pageHeight]);

  let y = pageHeight - PAD;

  // Logo
  const logoBytes = await loadLogo();
  if (logoBytes) {
    try {
      const logo = await pdf.embedPng(logoBytes);
      const targetW = 28 * PT_PER_MM;
      const aspect = logo.width / logo.height;
      const targetH = targetW / aspect;
      page.drawImage(logo, {
        x: (PAGE_W - targetW) / 2,
        y: y - targetH,
        width: targetW,
        height: targetH,
      });
      y -= targetH + 4;
    } catch {
      // Skip logo if embedding fails
    }
  }

  const drawCenteredMono = (text: string, size: number, font = monoFont) => {
    const w = font.widthOfTextAtSize(text, size);
    page.drawText(text, {
      x: (PAGE_W - w) / 2,
      y: y - size,
      size,
      font,
    });
    y -= size + 2;
  };

  const drawCenteredArabic = (text: string, size: number) => {
    const w = arabicFont.widthOfTextAtSize(text, size);
    page.drawText(text, {
      x: (PAGE_W - w) / 2,
      y: y - size,
      size,
      font: arabicFont,
    });
    y -= size + 2;
  };

  const drawDivider = () => {
    y -= 4;
    page.drawLine({
      start: { x: PAD, y },
      end: { x: PAGE_W - PAD, y },
      thickness: 0.7,
      color: rgb(0, 0, 0),
    });
    y -= 4;
  };

  const drawRowMono = (left: string, right: string, size = 9, bold = false) => {
    const f = bold ? monoBoldFont : monoFont;
    page.drawText(left, { x: PAD, y: y - size, size, font: f });
    const rw = f.widthOfTextAtSize(right, size);
    page.drawText(right, {
      x: PAGE_W - PAD - rw,
      y: y - size,
      size,
      font: f,
    });
    y -= size + 4;
  };

  drawCenteredMono(`*** ${data.shopName.toUpperCase()} ***`, 11, monoBoldFont);
  drawCenteredMono(`TEL: ${data.shopPhone}`, 8);
  drawCenteredArabic("العاشر من رمضان · الأردنية، خلف فودافون", 9);

  drawDivider();

  drawCenteredMono("*** RECEIPT ***", 14, monoBoldFont);
  drawCenteredMono(fmtDate(data.saleDate), 8);

  if (data.customerName || data.customerPhone) {
    if (data.customerName) drawCenteredArabic(`العميل: ${data.customerName}`, 9);
    if (data.customerPhone) drawCenteredMono(`TEL: ${data.customerPhone}`, 8);
  }

  drawDivider();

  // Items
  for (const line of data.lines) {
    drawRowMono(
      line.productName.slice(0, 24),
      fmtMoney(line.subtotal),
      9,
      true
    );
    if (line.brand) {
      page.drawText(`  BRAND: ${line.brand}`, {
        x: PAD,
        y: y - 8,
        size: 8,
        font: monoFont,
      });
      y -= 12;
    }
    if (line.quantity > 1) {
      page.drawText(
        `  x${line.quantity} @ ${fmtMoney(line.pricePerUnit)}`,
        { x: PAD, y: y - 8, size: 8, font: monoFont }
      );
      y -= 12;
    }
    if (line.lineDiscountAmount > 0) {
      page.drawText(
        `  DISC. (- ${fmtMoney(line.lineDiscountAmount)})`,
        { x: PAD, y: y - 8, size: 8, font: monoFont }
      );
      y -= 12;
    }
  }

  drawDivider();

  drawRowMono("SUBTOTAL", fmtMoney(data.cartSubtotal));
  if (data.orderDiscountAmount > 0) {
    drawRowMono("DISCOUNT", `- ${fmtMoney(data.orderDiscountAmount)}`);
  }

  drawDivider();

  drawRowMono("TOTAL AMOUNT", fmtMoney(data.totalPrice), 11, true);

  drawDivider();

  drawCenteredMono("THANK YOU FOR SHOPPING!", 9, monoBoldFont);
  drawCenteredArabic("شكراً لتسوقكم معنا ❤", 9);

  drawDivider();

  drawCenteredMono(
    `#${data.invoiceId.slice(-10).toUpperCase()}`,
    8,
    monoBoldFont
  );

  return pdf.save();
}
