"use client";

import { useState } from "react";
import { Share2, Copy, MessageCircle, Check } from "lucide-react";
import type { Sale } from "@/lib/types";

interface ShareReceiptButtonProps {
  sale: Sale;
  variant?: "icon" | "row";
}

export function ShareReceiptButton({ sale, variant = "icon" }: ShareReceiptButtonProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Receipts are PDF-only in v1 — no public web URL to share. The button
  // now copies a short text summary (no link) and offers to open WhatsApp
  // with the same text. PDF attachment goes via the dedicated WhatsApp flow.
  const message = `${sale.productName}${sale.brand ? ` — ${sale.brand}` : ""}\nالإجمالي: ${sale.totalPrice} ج.م`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        setOpen(false);
      }, 1200);
    } catch {
      // ignore
    }
  };

  const handleWhatsApp = () => {
    const phone = sale.customerPhone?.replace(/\D/g, "");
    const target = phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}`
      : `https://wa.me/?text=${encodeURIComponent(message)}`;
    window.open(target, "_blank");
    setOpen(false);
  };

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          variant === "icon"
            ? "p-1.5 bg-gray-100 text-text-secondary rounded-lg hover:bg-accent hover:text-white"
            : "flex-1 flex items-center justify-center gap-1 px-3 py-2 bg-gray-100 text-text-secondary rounded-xl hover:bg-gray-200 text-sm"
        }
        title="مشاركة"
      >
        <Share2 className="w-4 h-4" />
        {variant === "row" && <span>مشاركة</span>}
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />
          <div className="absolute end-0 top-full mt-1 z-20 bg-white border border-border rounded-lg shadow-lg min-w-[180px] overflow-hidden">
            <button
              onClick={handleCopy}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50"
            >
              {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
              {copied ? "تم النسخ" : "نسخ النص"}
            </button>
            <button
              onClick={handleWhatsApp}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 border-t border-border"
            >
              <MessageCircle className="w-4 h-4 text-success" />
              واتساب
              {sale.customerPhone && (
                <span className="text-xs text-text-secondary">→ {sale.customerPhone}</span>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
