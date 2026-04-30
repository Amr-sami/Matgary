"use client";

import { useEffect, useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Receipt } from "./Receipt";
import { InvoiceReceipt } from "./InvoiceReceipt";
import type { ReceiptSaleData, ReceiptInvoiceData } from "./SaleForm";

type PaperPreset = "auto_one" | "xp330b_80" | "thermal_58" | "a4" | "letter" | "custom";
type Orientation = "portrait" | "landscape";
type MarginPreset = "none" | "narrow" | "normal";

interface PrintOptions {
  paper: PaperPreset;
  widthMm: number;
  heightMm: number | "auto";
  orientation: Orientation;
  margin: MarginPreset;
  scale: number;
  copies: number;
  pagesPerSheet: 1 | 2 | 4;
  fitToPage: boolean;
}

const PAPER_SIZES: Record<
  PaperPreset,
  { label: string; widthMm: number; heightMm: number | "auto"; thermal: boolean; useDriverPaper: boolean }
> = {
  auto_one: {
    label: "تلقائي · نسخة واحدة لكل ورقة (موصى به)",
    widthMm: 80,
    heightMm: "auto",
    thermal: false,
    useDriverPaper: true,
  },
  xp330b_80: {
    label: "XP-330B حراري 80mm",
    widthMm: 80,
    heightMm: "auto",
    thermal: true,
    useDriverPaper: false,
  },
  thermal_58: {
    label: "حراري 58mm",
    widthMm: 58,
    heightMm: "auto",
    thermal: true,
    useDriverPaper: false,
  },
  a4: { label: "A4 (210 × 297mm)", widthMm: 210, heightMm: 297, thermal: false, useDriverPaper: false },
  letter: { label: "Letter (216 × 279mm)", widthMm: 216, heightMm: 279, thermal: false, useDriverPaper: false },
  custom: { label: "مخصص", widthMm: 80, heightMm: "auto", thermal: true, useDriverPaper: false },
};

const MARGIN_MM: Record<MarginPreset, number> = {
  none: 0,
  narrow: 3,
  normal: 10,
};

const DEFAULT_OPTS: PrintOptions = {
  paper: "auto_one",
  widthMm: 80,
  heightMm: "auto",
  orientation: "portrait",
  margin: "none",
  scale: 100,
  copies: 1,
  pagesPerSheet: 1,
  fitToPage: true,
};

interface PrintOptionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  receiptData: ReceiptSaleData | null;
  invoiceData?: ReceiptInvoiceData | null;
  onConfirm: () => void;
}

function buildPrintStyle(opts: PrintOptions, preset: typeof PAPER_SIZES[PaperPreset]): string {
  const { widthMm, heightMm, orientation, margin, scale, pagesPerSheet, fitToPage } = opts;
  const mm = MARGIN_MM[margin];
  const contentWidth = Math.max(widthMm - mm * 2, 20);

  // Three modes:
  // 1. useDriverPaper (auto_one): no @page size — printer uses its own paper
  //    (A4/Letter/whatever the user picks in the browser dialog). One receipt
  //    centered per sheet. This is the only mode that *guarantees* no 4-up tiling.
  // 2. thermal: @page is locked to the roll width so the printer cuts correctly.
  // 3. fixed paper (A4/Letter/custom): @page matches the chosen size.
  let pageRule: string;
  if (preset.useDriverPaper) {
    pageRule = `@page { margin: ${mm}mm; }`;
  } else if (preset.thermal) {
    pageRule = `@page { size: ${widthMm}mm ${heightMm === "auto" ? "auto" : `${heightMm}mm`} ${orientation}; margin: ${mm}mm; }`;
  } else {
    const sizePart = heightMm === "auto" ? `${widthMm}mm auto` : `${widthMm}mm ${heightMm}mm`;
    pageRule = `@page { size: ${sizePart} ${orientation}; margin: ${mm}mm; }`;
  }

  const gridCols = pagesPerSheet >= 2 ? 2 : 1;
  const gridRows = pagesPerSheet === 4 ? 2 : 1;

  // fitToPage stretches the receipt vertically to fill the page so there is no
  // blank space between the bottom of the receipt and the bottom of the paper.
  // Implemented via flex column on the wrapper + flex-grow on a spacer-less
  // receipt container. We use min-height: 100vh on the container.
  const fitRules = fitToPage && pagesPerSheet === 1
    ? `
      .print-receipt-container > * {
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }
    `
    : "";

  return `
    @media print {
      html, body { background: #fff !important; }
      ${pageRule}
      .print-receipt-container {
        display: ${pagesPerSheet > 1 ? "grid" : "block"} !important;
        ${pagesPerSheet > 1 ? `grid-template-columns: repeat(${gridCols}, 1fr); grid-template-rows: repeat(${gridRows}, auto); gap: 4mm;` : ""}
        width: ${contentWidth}mm !important;
        margin: 0 auto !important;
        transform: scale(${scale / 100});
        transform-origin: top center;
      }
      .receipt {
        width: 100% !important;
        page-break-after: always;
        break-after: page;
      }
      .receipt:last-child {
        page-break-after: auto;
        break-after: auto;
      }
      ${fitRules}
    }
  `;
}

export function PrintOptionsModal({ isOpen, onClose, receiptData, invoiceData, onConfirm }: PrintOptionsModalProps) {
  const useInvoice = !!invoiceData;
  const [opts, setOpts] = useState<PrintOptions>(DEFAULT_OPTS);

  const selectedPaper = PAPER_SIZES[opts.paper];

  useEffect(() => {
    if (isOpen) setOpts(DEFAULT_OPTS);
  }, [isOpen]);

  const handlePaperChange = (paper: PaperPreset) => {
    const preset = PAPER_SIZES[paper];
    setOpts((o) => ({
      ...o,
      paper,
      widthMm: preset.widthMm,
      heightMm: preset.heightMm,
      orientation: preset.thermal || preset.useDriverPaper ? "portrait" : o.orientation,
      margin: preset.thermal || preset.useDriverPaper ? "none" : "normal",
      pagesPerSheet: preset.thermal || preset.useDriverPaper ? 1 : o.pagesPerSheet,
    }));
  };

  const renderCopiesCount = useMemo(
    () => Array.from({ length: opts.copies }, (_, i) => i),
    [opts.copies]
  );

  const handlePrint = () => {
    if (!receiptData && !invoiceData) return;
    const existing = document.getElementById("print-options-dynamic");
    if (existing) existing.remove();

    const style = document.createElement("style");
    style.id = "print-options-dynamic";
    style.textContent = buildPrintStyle(opts, selectedPaper);
    document.head.appendChild(style);

    const cleanup = () => {
      const el = document.getElementById("print-options-dynamic");
      if (el) el.remove();
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);

    requestAnimationFrame(() => {
      window.print();
      onConfirm();
    });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="خيارات الطباعة" className="max-w-3xl">
      <div className="grid lg:grid-cols-2 gap-4 sm:gap-6">
        {/* Options Column */}
        <div className="space-y-4 order-2 lg:order-1">
          <div>
            <label className="block text-sm font-medium mb-2">مقاس الورق</label>
            <div className="grid grid-cols-1 gap-2">
              {(Object.keys(PAPER_SIZES) as PaperPreset[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => handlePaperChange(key)}
                  className={`text-right px-3 py-2 rounded-lg border text-sm transition-colors ${
                    opts.paper === key
                      ? "bg-accent text-white border-accent"
                      : "bg-white border-border hover:bg-accent-light"
                  }`}
                >
                  {PAPER_SIZES[key].label}
                </button>
              ))}
            </div>
          </div>

          {opts.paper === "custom" && (
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="العرض (mm)"
                type="number"
                min={20}
                max={420}
                value={opts.widthMm}
                onChange={(e) => setOpts((o) => ({ ...o, widthMm: Number(e.target.value) }))}
              />
              <Input
                label="الارتفاع (mm، 0 = تلقائي)"
                type="number"
                min={0}
                max={1000}
                value={opts.heightMm === "auto" ? 0 : opts.heightMm}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setOpts((o) => ({ ...o, heightMm: v > 0 ? v : "auto" }));
                }}
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium mb-2">الاتجاه</label>
            <div className="flex rounded-lg overflow-hidden border border-border">
              {(["portrait", "landscape"] as Orientation[]).map((o) => (
                <button
                  key={o}
                  type="button"
                  disabled={selectedPaper.thermal}
                  onClick={() => setOpts((prev) => ({ ...prev, orientation: o }))}
                  className={`flex-1 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    opts.orientation === o ? "bg-accent text-white" : "bg-white text-text-secondary"
                  }`}
                >
                  {o === "portrait" ? "طولي" : "عرضي"}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">الهوامش</label>
            <div className="flex rounded-lg overflow-hidden border border-border">
              {(["none", "narrow", "normal"] as MarginPreset[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setOpts((o) => ({ ...o, margin: m }))}
                  className={`flex-1 py-2 text-xs font-medium transition-colors ${
                    opts.margin === m ? "bg-accent text-white" : "bg-white text-text-secondary"
                  }`}
                >
                  {m === "none" ? "بدون" : m === "narrow" ? "ضيق" : "عادي"}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">
              الحجم (Scale): {opts.scale}%
            </label>
            <input
              type="range"
              min={50}
              max={150}
              step={5}
              value={opts.scale}
              onChange={(e) => setOpts((o) => ({ ...o, scale: Number(e.target.value) }))}
              className="w-full"
            />
          </div>

          <Input
            label="عدد النسخ"
            type="number"
            min={1}
            max={10}
            value={opts.copies}
            onChange={(e) =>
              setOpts((o) => ({ ...o, copies: Math.max(1, Math.min(10, Number(e.target.value))) }))
            }
          />

          {!selectedPaper.thermal && !selectedPaper.useDriverPaper && (
            <div>
              <label className="block text-sm font-medium mb-2">صفحات في الورقة</label>
              <div className="flex rounded-lg overflow-hidden border border-border">
                {([1, 2, 4] as const).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setOpts((o) => ({ ...o, pagesPerSheet: n }))}
                    className={`flex-1 py-2 text-sm font-medium transition-colors ${
                      opts.pagesPerSheet === n ? "bg-accent text-white" : "bg-white text-text-secondary"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          )}

          {opts.pagesPerSheet === 1 && (
            <label className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border bg-white cursor-pointer">
              <div>
                <p className="text-sm font-medium">ملء الصفحة (بدون فراغ أسفل الفاتورة)</p>
                <p className="text-xs text-text-secondary mt-0.5">
                  يمد الفاتورة لتغطي ارتفاع الورقة كاملاً.
                </p>
              </div>
              <input
                type="checkbox"
                checked={opts.fitToPage}
                onChange={(e) => setOpts((o) => ({ ...o, fitToPage: e.target.checked }))}
                className="w-5 h-5 accent-accent"
              />
            </label>
          )}

          <p className="text-xs text-text-secondary bg-accent-light p-2 rounded leading-relaxed">
            <strong>منع تكرار الفاتورة 4 مرات:</strong> اختر &quot;تلقائي · نسخة واحدة لكل ورقة&quot;
            (الافتراضي). هذا الخيار يستخدم مقاس الورق الفعلي للطابعة فيطبع نسخة واحدة فقط في الورقة.
            استخدم XP-330B فقط مع الطابعة الحرارية.
          </p>
        </div>

        {/* Preview Column */}
        <div className="space-y-2 order-1 lg:order-2">
          <label className="block text-sm font-medium">معاينة</label>
          <div className="border border-border rounded-lg bg-bg-main p-2 sm:p-4 max-h-[40vh] lg:max-h-[60vh] overflow-auto flex justify-center">
            <div
              className="receipt-preview w-full max-w-[272px]"
              style={{
                background: "#fff",
                border: "1px solid var(--border)",
              }}
            >
              {useInvoice && invoiceData ? (
                <InvoiceReceipt invoice={invoiceData} />
              ) : receiptData ? (
                <Receipt sale={receiptData} />
              ) : (
                <p className="text-center text-text-secondary text-sm p-8">لا توجد بيانات</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 sm:gap-3 mt-6 pt-4 border-t border-border">
        <Button variant="ghost" onClick={onClose} className="w-full sm:w-auto">
          إلغاء
        </Button>
        <Button onClick={handlePrint} disabled={!receiptData && !invoiceData} className="flex items-center justify-center gap-2 w-full sm:w-auto">
          <Printer className="w-4 h-4" />
          طباعة ({opts.copies}× نسخة)
        </Button>
      </div>

      {/* Printable container — hidden on screen, revealed for print */}
      {(receiptData || invoiceData) && (
        <div className="print-receipt-container" aria-hidden="true">
          {renderCopiesCount.map((i) => (
            <div key={i} className={i > 0 ? "receipt-page-break" : undefined}>
              {useInvoice && invoiceData ? (
                <InvoiceReceipt invoice={invoiceData} />
              ) : receiptData ? (
                <Receipt sale={receiptData} />
              ) : null}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export type { PrintOptions };
