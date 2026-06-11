// Below-the-fold settings card extracted from app/settings/page.tsx as
// part of the Phase 4D decomposition. Imported via `next/dynamic` on
// the parent page so its ~7 KB of JSX + live-preview math doesn't ship
// in the settings page's initial bundle.
//
// Pure view component — takes (draft, update) callbacks from the parent's
// settings draft state. No fetches, no internal state.

"use client";

import { useDictionary } from "@/components/i18n/DictionaryProvider";
import type { ShopSettings } from "@/lib/settings";

export interface ReceiptCustomisationCardProps {
  draft: ShopSettings;
  update: <K extends keyof ShopSettings>(key: K, value: ShopSettings[K]) => void;
}

export default function ReceiptCustomisationCard({
  draft,
  update,
}: ReceiptCustomisationCardProps) {
  const dict = useDictionary();
  const t = dict.app.settingsPage.receiptCard;
  const sizeLabels = dict.app.settingsPage.receiptLogoSize;
  const langLabels = dict.app.settingsPage.receiptLanguage;
  const LOGO_SIZE_OPTIONS: { value: ShopSettings["receiptLogoSize"]; label: string }[] = [
    { value: "hidden", label: sizeLabels.hidden },
    { value: "small", label: sizeLabels.small },
    { value: "medium", label: sizeLabels.medium },
    { value: "large", label: sizeLabels.large },
  ];
  const LANGUAGE_OPTIONS: { value: ShopSettings["receiptLanguage"]; label: string; hint: string }[] = [
    { value: "ar", label: langLabels.ar, hint: langLabels.arHint },
    { value: "en", label: langLabels.en, hint: langLabels.enHint },
    { value: "bilingual", label: langLabels.bilingual, hint: langLabels.bilingualHint },
  ];

  // Live mock preview keeps the printed-receipt sample bilingual — that's
  // a customer-facing artefact (the actual printed receipt) and the
  // bilingual/AR/EN choice the owner makes here drives what the customer
  // sees.
  const lang = draft.receiptLanguage;
  const T = (en: string, ar: string) =>
    lang === "en" ? en : lang === "ar" ? ar : `${en} · ${ar}`;
  const shopName = (draft.shopName || "STORE").toUpperCase();

  return (
    <div className="bg-white rounded-xl border border-border p-5 space-y-4">
      <div>
        <h3 className="font-bold text-lg">{t.heading}</h3>
        <p className="text-xs text-text-secondary mt-0.5">{t.subhead}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Logo size */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            {t.logoSize}
          </label>
          <select
            value={draft.receiptLogoSize}
            onChange={(e) =>
              update(
                "receiptLogoSize",
                e.target.value as ShopSettings["receiptLogoSize"],
              )
            }
            className="w-full px-3 py-2.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {LOGO_SIZE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-text-secondary mt-1">{t.logoHint}</p>
        </div>

        {/* Language */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            {t.language}
          </label>
          <div className="space-y-1.5">
            {LANGUAGE_OPTIONS.map((o) => (
              <label
                key={o.value}
                className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${
                  draft.receiptLanguage === o.value
                    ? "border-accent bg-accent-light/30"
                    : "border-border"
                }`}
              >
                <input
                  type="radio"
                  name="receipt-language"
                  checked={draft.receiptLanguage === o.value}
                  onChange={() => update("receiptLanguage", o.value)}
                  className="mt-1 accent-accent"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{o.label}</p>
                  <p className="text-[10px] text-text-secondary truncate">
                    {o.hint}
                  </p>
                </div>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Footer text */}
      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1.5">
          {t.footerLabel}
        </label>
        <textarea
          value={draft.receiptFooterText}
          onChange={(e) => update("receiptFooterText", e.target.value)}
          dir="auto"
          rows={3}
          maxLength={500}
          placeholder={t.footerPlaceholder}
          className="w-full px-3 py-2.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <p className="text-[10px] text-text-secondary mt-1">
          {t.footerCount.replace("{n}", String(draft.receiptFooterText.length))}
        </p>
      </div>

      {/* Show loyalty toggle */}
      <label className="flex items-start gap-3 p-3 rounded-lg border border-border cursor-pointer">
        <input
          type="checkbox"
          checked={draft.receiptShowLoyalty}
          onChange={(e) => update("receiptShowLoyalty", e.target.checked)}
          className="mt-1 w-5 h-5 accent-accent"
        />
        <div className="flex-1">
          <p className="font-medium">{t.showLoyalty}</p>
          <p className="text-xs text-text-secondary mt-0.5">
            {t.showLoyaltyHint}
          </p>
        </div>
      </label>

      {/* Live preview */}
      <div className="rounded-lg border border-dashed border-border bg-bg-main p-3">
        <p className="text-[10px] text-text-secondary mb-2 text-center">
          {t.previewLabel}
        </p>
        <div className="mx-auto bg-white border border-border rounded p-3 max-w-xs text-[11px] leading-relaxed font-mono text-black">
          {draft.receiptLogoSize !== "hidden" && (
            <div className="text-center mb-1">
              <div
                className={`inline-block bg-bg-main rounded ${
                  draft.receiptLogoSize === "small"
                    ? "w-10 h-10"
                    : draft.receiptLogoSize === "large"
                      ? "w-24 h-24"
                      : "w-16 h-16"
                }`}
                aria-hidden
              />
            </div>
          )}
          <div className="text-center font-bold tracking-wide" dir="auto">
            {shopName}
          </div>
          {draft.shopPhone && (
            <div className="text-center" dir="ltr">
              TEL: {draft.shopPhone}
            </div>
          )}
          <hr className="my-1 border-black" />
          <div className="text-center font-black tracking-widest">
            {T("*** RECEIPT ***", "*** فاتورة ***")}
          </div>
          <hr className="my-1 border-black" />
          <div className="flex justify-between">
            <span>SAMPLE ITEM</span>
            <span>100.00 ج.م</span>
          </div>
          <hr className="my-1 border-black" />
          <div className="flex justify-between">
            <span>{T("SUBTOTAL", "المجموع")}</span>
            <span>100.00 ج.م</span>
          </div>
          {draft.receiptShowLoyalty && draft.loyaltyEnabled && (
            <>
              <div className="flex justify-between">
                <span>{T("CREDIT APPLIED", "رصيد مستخدم")}</span>
                <span>- 10.00 ج.م</span>
              </div>
            </>
          )}
          <hr className="my-1 border-black" />
          <div className="flex justify-between font-black">
            <span>{T("TOTAL AMOUNT", "الإجمالي")}</span>
            <span>
              {draft.receiptShowLoyalty && draft.loyaltyEnabled
                ? "90.00"
                : "100.00"}{" "}
              ج.م
            </span>
          </div>
          {draft.receiptShowLoyalty && draft.loyaltyEnabled && (
            <>
              <hr className="my-1 border-black" />
              <div className="flex justify-between">
                <span>{T("POINTS EARNED", "نقاط مكتسبة")}</span>
                <span>+9</span>
              </div>
            </>
          )}
          <hr className="my-1 border-black" />
          <div className="text-center font-bold">
            {T("THANK YOU FOR SHOPPING!", "شكراً لتسوقكم معنا")}
          </div>
          {draft.receiptFooterText && (
            <div
              dir="auto"
              className="text-center whitespace-pre-wrap mt-1 text-[10px]"
            >
              {draft.receiptFooterText}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
