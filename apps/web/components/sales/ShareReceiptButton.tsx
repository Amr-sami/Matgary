"use client";

import { useState } from "react";
import { Share2, Copy, MessageCircle, Check } from "@/lib/icons";
import type { Sale } from "@/lib/types";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";

interface ShareReceiptButtonProps {
  sale: Sale;
  variant?: "icon" | "row";
}

export function ShareReceiptButton({ sale, variant = "icon" }: ShareReceiptButtonProps) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.sales.share;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Receipts are PDF-only in v1 — no public web URL to share. The button
  // now copies a short text summary (no link) and offers to open WhatsApp
  // with the same text. PDF attachment goes via the dedicated WhatsApp flow.
  const totalLine = t.messageTotal.replace(
    "{amount}",
    formatCurrency(sale.totalPrice, locale),
  );
  const message = `${sale.productName}${sale.brand ? ` — ${sale.brand}` : ""}\n${totalLine}`;

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
            ? "p-1.5 rounded-lg text-text-secondary hover:text-accent hover:opacity-90 transition-colors"
            : "flex-1 flex items-center justify-center gap-1 px-3 py-2 text-text-secondary active:opacity-70 transition-opacity text-sm"
        }
        title={t.title}
      >
        <Share2 className="w-4 h-4" />
        {variant === "row" && <span>{t.title}</span>}
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
              {copied ? t.copied : t.copy}
            </button>
            <button
              onClick={handleWhatsApp}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 border-t border-border"
            >
              <MessageCircle className="w-4 h-4 text-success" />
              {t.whatsapp}
              {sale.customerPhone && (
                <span className="text-xs text-text-secondary" dir="ltr">→ {sale.customerPhone}</span>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
