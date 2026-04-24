"use client";

import { useEffect, useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Receipt } from "./Receipt";
import type { ReceiptSaleData } from "./SaleForm";

type PaperPreset = "xp330b_80" | "thermal_58" | "a4" | "letter" | "custom";
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
}

const PAPER_SIZES: Record<PaperPreset, { label: string; widthMm: number; heightMm: number | "auto"; thermal: boolean }> = {
  xp330b_80: { label: "XP-330B حراري 80mm (افتراضي)", widthMm: 80, heightMm: "auto", thermal: true },
  thermal_58: { label: "حراري 58mm", widthMm: 58, heightMm: "auto", thermal: true },
  a4: { label: "A4 (210 × 297mm)", widthMm: 210, heightMm: 297, thermal: false },
  letter: { label: "Letter (216 × 279mm)", widthMm: 216, heightMm: 279, thermal: false },
  custom: { label: "مخصص", widthMm: 80, heightMm: "auto", thermal: true },
};

const MARGIN_MM: Record<MarginPreset, number> = {
  none: 0,
  narrow: 3,
  normal: 10,
};

const DEFAULT_OPTS: PrintOptions = {
  paper: "xp330b_80",
  widthMm: 80,
  heightMm: "auto",
  orientation: "portrait",
  margin: "none",
  scale: 100,
  copies: 1,
  pagesPerSheet: 1,
};

interface PrintOptionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  receiptData: ReceiptSaleData | null;
  onConfirm: () => void;
}

function buildPrintStyle(opts: PrintOptions): string {
  const { widthMm, heightMm, orientation, margin, scale, pagesPerSheet } = opts;
  const mm = MARGIN_MM[margin];
  const size = heightMm === "auto" ? `${widthMm}mm auto` : `${widthMm}mm ${heightMm}mm`;
  const contentWidth = Math.max(widthMm - mm * 2, 20);

  // Pages-per-sheet via grid on the printable container
  const gridCols = pagesPerSheet >= 2 ? 2 : 1;
  const gridRows = pagesPerSheet === 4 ? 2 : 1;

  return `
    @media print {
      @page {
        size: ${size} ${orientation};
        margin: ${mm}mm;
      }
      .print-receipt-container {
        display: ${pagesPerSheet > 1 ? "grid" : "block"} !important;
        ${pagesPerSheet > 1 ? `grid-template-columns: repeat(${gridCols}, 1fr); grid-template-rows: repeat(${gridRows}, auto); gap: 4mm;` : ""}
        width: ${contentWidth}mm !important;
        transform: scale(${scale / 100});
        transform-origin: top ${orientation === "portrait" ? "right" : "left"};
      }
      .receipt {
        width: 100% !important;
      }
    }
  `;
}

export function PrintOptionsModal({ isOpen, onClose, receiptData, onConfirm }: PrintOptionsModalProps) {
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
      orientation: preset.thermal ? "portrait" : o.orientation,
      margin: preset.thermal ? "none" : "normal",
      pagesPerSheet: preset.thermal ? 1 : o.pagesPerSheet,
    }));
  };

  const renderCopiesCount = useMemo(() => Array.from({ length: opts.copies }, (_, i) => i), [opts.copies]);

  const handlePrint = () => {
    if (!receiptData) return;
    const existing = document.getElementById("print-options-dynamic");
    if (existing) existing.remove();

    const style = document.createElement("style");
    style.id = "print-options-dynamic";
    style.textContent = buildPrintStyle(opts);
    document.head.appendChild(style);

    const cleanup = () => {
      const el = document.getElementById("print-options-dynamic");
      if (el) el.remove();
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);

    // Let the DOM settle with the new <style>, then invoke native dialog
    requestAnimationFrame(() => {
      window.print();
      onConfirm();
    });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="خيارات الطباعة" className="max-w-3xl">
      <div className="grid md:grid-cols-2 gap-6">
        {/* Options Column */}
        <div className="space-y-4">
          {/* Paper size */}
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
                      : "bg-white border-border hover:bg-gray-50"
                  }`}
                >
                  {PAPER_SIZES[key].label}
                </button>
              ))}
            </div>
          </div>

          {/* Custom width (only when preset === custom) */}
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

          {/* Orientation */}
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

          {/* Margins */}
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

          {/* Scale */}
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

          {/* Copies */}
          <Input
            label="عدد النسخ"
            type="number"
            min={1}
            max={10}
            value={opts.copies}
            onChange={(e) => setOpts((o) => ({ ...o, copies: Math.max(1, Math.min(10, Number(e.target.value))) }))}
          />

          {/* Pages per sheet (only for non-thermal) */}
          {!selectedPaper.thermal && (
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

          {/* Hardware hint */}
          <p className="text-xs text-text-secondary bg-accent-light/50 p-2 rounded">
            XP-330B: 80mm ، 203 DPI ، 127mm/s · تُختار الطابعة من نافذة المتصفح بعد الضغط.
          </p>
        </div>

        {/* Preview Column */}
        <div className="space-y-2">
          <label className="block text-sm font-medium">معاينة</label>
          <div className="border border-border rounded-lg bg-gray-100 p-4 max-h-[60vh] overflow-auto flex justify-center">
            <div
              className="receipt-preview shadow-md"
              style={{
                width: `${Math.min(opts.widthMm, 80) * 3.4}px`,
                background: "#fff",
                border: "1px solid #e5e7eb",
              }}
            >
              {receiptData ? (
                <Receipt sale={receiptData} />
              ) : (
                <p className="text-center text-text-secondary text-sm p-8">لا توجد بيانات</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-border">
        <Button variant="ghost" onClick={onClose}>
          إلغاء
        </Button>
        <Button onClick={handlePrint} disabled={!receiptData} className="flex items-center gap-2">
          <Printer className="w-4 h-4" />
          طباعة ({opts.copies}× نسخة)
        </Button>
      </div>

      {/* Printable container — sole source of truth at print time */}
      {receiptData && (
        <div className="print-receipt-container" aria-hidden="true">
          {renderCopiesCount.map((i) => (
            <div key={i} className={i > 0 ? "receipt-page-break" : undefined}>
              <Receipt sale={receiptData} />
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export type { PrintOptions };
