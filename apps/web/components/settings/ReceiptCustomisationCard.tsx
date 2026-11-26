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
import { TextAlignLeft, TextAlignCenter, TextAlignRight } from "@/lib/icons";

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
  // Locale-aware labels for the alignment picker — read from the dictionary
  // so the screen reader announces them in the Owner's language.
  const alignLabels: Record<Align, string> = {
    left: t.alignLeft,
    center: t.alignCenter,
    right: t.alignRight,
  };

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

      {/* Receipt identity (0065 + 0066 toggles). Each row combines text +
          show/hide. Empty text → row hidden; show-flag off → row hidden even
          when the text is set (lets the Owner suspend a row without losing
          it). Reorganised so the slogan is spotlighted with example chips —
          Owners miss it when it sits mixed into the grid. */}
      <div className="pt-2 border-t border-border space-y-4">
        <div>
          <h4 className="font-semibold text-sm">{t.identityHeading}</h4>
          <p className="text-xs text-text-secondary mt-0.5">
            {t.identitySubhead}
          </p>
        </div>

        {/* Store name + phone row — not optional and always shown, so this
            card has no visibility toggle. Carries the shopPhone field that
            previously lived on Settings → Store Info only; Owners expected
            to edit "the phone that prints on the receipt" from here. */}
        <div className="rounded-lg border border-border bg-bg-main/40 p-3 space-y-3">
          <div>
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <label className="block text-sm font-medium text-text-secondary">
                {t.phoneLabel}
              </label>
              <AlignmentPicker
                value={alignOf(draft.receiptBlockAlignments, "phone")}
                onChange={(v) =>
                  update(
                    "receiptBlockAlignments",
                    withAlign(draft.receiptBlockAlignments, "phone", v),
                  )
                }
                labels={alignLabels}
              />
            </div>
            <input
              type="tel"
              value={draft.shopPhone}
              dir="ltr"
              maxLength={40}
              placeholder={t.phonePlaceholder}
              onChange={(e) => update("shopPhone", e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <p className="text-[10px] text-text-secondary mt-0.5">
              {t.phoneHint}
            </p>
          </div>
          {/* Store name alignment — the name itself is on Store Info, but
              where it SITS on the receipt is a receipt-page concern. */}
          <div className="flex items-center justify-between gap-2">
            <label className="text-sm font-medium text-text-secondary">
              {t.nameAlignmentLabel}
            </label>
            <AlignmentPicker
              value={alignOf(draft.receiptBlockAlignments, "name")}
              onChange={(v) =>
                update(
                  "receiptBlockAlignments",
                  withAlign(draft.receiptBlockAlignments, "name", v),
                )
              }
              labels={alignLabels}
            />
          </div>
        </div>

        {/* Slogan — spotlight card. The owner specifically asked for the
            "message under the receipt" to be clearly discoverable, so it
            lives above the grid with example chips that tap-to-fill. */}
        <div className="rounded-lg border border-accent/30 bg-accent-light/20 p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1">
              <label className="block text-sm font-semibold">
                {t.sloganLabel}
              </label>
              <p className="text-[11px] text-text-secondary mt-0.5">
                {t.sloganHint}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <AlignmentPicker
                value={alignOf(draft.receiptBlockAlignments, "slogan")}
                onChange={(v) =>
                  update(
                    "receiptBlockAlignments",
                    withAlign(draft.receiptBlockAlignments, "slogan", v),
                  )
                }
                labels={alignLabels}
              />
              <ShowToggle
                checked={draft.receiptShowSlogan}
                onChange={(v) => update("receiptShowSlogan", v)}
                label={t.showToggle}
              />
            </div>
          </div>
          <textarea
            value={draft.receiptSlogan}
            dir="auto"
            rows={2}
            maxLength={200}
            placeholder={t.sloganPlaceholder}
            onChange={(e) => update("receiptSlogan", e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <div className="flex flex-wrap gap-1.5">
            {SLOGAN_SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => update("receiptSlogan", suggestion)}
                className="text-[11px] px-2 py-1 rounded-full border border-border bg-white hover:bg-bg-main"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <IdentityField
            label={t.addressLabel}
            hint={t.addressHint}
            placeholder={t.addressPlaceholder}
            value={draft.receiptAddress}
            maxLength={200}
            multiline
            onChange={(v) => update("receiptAddress", v)}
            showToggle={{
              checked: draft.receiptShowAddress,
              onChange: (v) => update("receiptShowAddress", v),
              label: t.showToggle,
            }}
            alignment={{
              value: alignOf(draft.receiptBlockAlignments, "address"),
              onChange: (v) =>
                update(
                  "receiptBlockAlignments",
                  withAlign(draft.receiptBlockAlignments, "address", v),
                ),
            }}
          />
          <IdentityField
            label={t.returnPolicyLabel}
            hint={t.returnPolicyHint}
            placeholder={t.returnPolicyPlaceholder}
            value={draft.receiptReturnPolicy}
            maxLength={500}
            multiline
            onChange={(v) => update("receiptReturnPolicy", v)}
            showToggle={{
              checked: draft.receiptShowReturnPolicy,
              onChange: (v) => update("receiptShowReturnPolicy", v),
              label: t.showToggle,
            }}
            alignment={{
              value: alignOf(draft.receiptBlockAlignments, "returnPolicy"),
              onChange: (v) =>
                update(
                  "receiptBlockAlignments",
                  withAlign(draft.receiptBlockAlignments, "returnPolicy", v),
                ),
            }}
          />
          {/* Tax reg + tax card share a single toggle — the Owner prints tax
              info or doesn't; two toggles here get no UX win. Each row still
              has its own alignment since the Owner may want them on different
              edges of the paper. */}
          <IdentityField
            label={t.taxRegLabel}
            placeholder={t.taxRegPlaceholder}
            value={draft.receiptTaxRegistration}
            maxLength={80}
            onChange={(v) => update("receiptTaxRegistration", v)}
            showToggle={{
              checked: draft.receiptShowTaxInfo,
              onChange: (v) => update("receiptShowTaxInfo", v),
              label: t.showTaxToggle,
            }}
            alignment={{
              value: alignOf(draft.receiptBlockAlignments, "taxReg"),
              onChange: (v) =>
                update(
                  "receiptBlockAlignments",
                  withAlign(draft.receiptBlockAlignments, "taxReg", v),
                ),
            }}
          />
          <IdentityField
            label={t.taxCardLabel}
            placeholder={t.taxCardPlaceholder}
            value={draft.receiptTaxCardNumber}
            maxLength={80}
            onChange={(v) => update("receiptTaxCardNumber", v)}
            alignment={{
              value: alignOf(draft.receiptBlockAlignments, "taxCard"),
              onChange: (v) =>
                update(
                  "receiptBlockAlignments",
                  withAlign(draft.receiptBlockAlignments, "taxCard", v),
                ),
            }}
          />
          <IdentityField
            label={t.referencePrefixLabel}
            hint={t.referencePrefixHint}
            placeholder={t.referencePrefixPlaceholder}
            value={draft.receiptReferencePrefix}
            maxLength={8}
            onChange={(v) =>
              update(
                "receiptReferencePrefix",
                v.replace(/[^A-Za-z0-9-]/g, "").toUpperCase().slice(0, 8),
              )
            }
          />
        </div>

        <p className="text-[11px] text-text-secondary">{t.emptyHidesHint}</p>
      </div>

      {/* Live preview — mirrors the production receipt renderer (web
          InvoiceReceipt + mobile buildReceiptHtml). Every identity row obeys
          its text AND its visibility toggle; owner edits reflect immediately
          with no save. Sample sale data (two items, line discount, total) is
          hardcoded — real sales use the actual cart. */}
      <div className="rounded-lg border border-dashed border-border bg-bg-main p-3">
        <p className="text-[10px] text-text-secondary mb-2 text-center">
          {t.previewLabel}
        </p>
        <ReceiptPreview draft={draft} T={T} />
      </div>
    </div>
  );
}

function ReceiptPreview({
  draft,
  T,
}: {
  draft: ShopSettings;
  T: (en: string, ar: string) => string;
}) {
  const shopName = (draft.shopName || "STORE").toUpperCase();
  const showAddr = draft.receiptShowAddress && draft.receiptAddress.trim();
  const showSlog = draft.receiptShowSlogan && draft.receiptSlogan.trim();
  const showTaxReg =
    draft.receiptShowTaxInfo && draft.receiptTaxRegistration.trim();
  const showTaxCard =
    draft.receiptShowTaxInfo && draft.receiptTaxCardNumber.trim();
  const showPol =
    draft.receiptShowReturnPolicy && draft.receiptReturnPolicy.trim();
  const refCode = draft.receiptReferencePrefix
    ? `${draft.receiptReferencePrefix}-A1B2C3D4E5`
    : "A1B2C3D4E5";
  // Freeze preview date to a fixed sample so the layout doesn't jitter as
  // the clock ticks — the real receipt uses the sale timestamp.
  const sampleDate = "15/11/2026 - 03:42 PM";
  // Alignment helper — a thin wrapper around alignOf so the preview JSX
  // stays tight. Returns the `text-align` style for a given row key.
  const a = (key: string): React.CSSProperties => ({
    textAlign: alignOf(draft.receiptBlockAlignments, key),
  });

  return (
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
      <div className="font-bold tracking-wide" dir="auto" style={a("name")}>
        {shopName}
      </div>
      {showAddr && (
        <div
          dir="auto"
          className="whitespace-pre-wrap text-[10px]"
          style={a("address")}
        >
          {draft.receiptAddress}
        </div>
      )}
      {draft.shopPhone && (
        <div dir="ltr" style={a("phone")}>
          TEL: {draft.shopPhone}
        </div>
      )}
      {showSlog && (
        <div dir="auto" className="text-[10px]" style={a("slogan")}>
          {draft.receiptSlogan}
        </div>
      )}
      {showTaxReg && (
        <div dir="auto" className="text-[10px]" style={a("taxReg")}>
          {T("TAX REG", "س.ت")}: {draft.receiptTaxRegistration}
        </div>
      )}
      {showTaxCard && (
        <div dir="auto" className="text-[10px]" style={a("taxCard")}>
          {T("TAX CARD", "ب.ض")}: {draft.receiptTaxCardNumber}
        </div>
      )}
      <hr className="my-1 border-black" />
      <div className="text-center font-black tracking-widest">
        {T("*** RECEIPT ***", "*** فاتورة ***")}
      </div>
      <div className="text-[10px] text-center" dir="ltr">
        {sampleDate}
      </div>
      <hr className="my-1 border-black" />
      <div className="flex justify-between">
        <span>{T("SHIRT · BLUE", "قميص · أزرق")}</span>
        <span>250.00 ج.م</span>
      </div>
      <div className="text-[10px] ps-2">x2 @ 125.00 ج.م</div>
      <div className="flex justify-between">
        <span>{T("CAP · BLACK", "كاب · أسود")}</span>
        <span>80.00 ج.م</span>
      </div>
      <div className="text-[10px] ps-2">
        {T("DISCOUNT", "الخصم")} (- 10.00 ج.م)
      </div>
      <hr className="my-1 border-black" />
      <div className="flex justify-between">
        <span>{T("SUBTOTAL", "المجموع")}</span>
        <span>330.00 ج.م</span>
      </div>
      <div className="flex justify-between">
        <span>{T("LINE DISCOUNTS", "خصومات الأصناف")}</span>
        <span>- 10.00 ج.م</span>
      </div>
      <hr className="my-1 border-black" />
      <div className="flex justify-between font-black">
        <span>{T("TOTAL AMOUNT", "الإجمالي")}</span>
        <span>320.00 ج.م</span>
      </div>
      <div className="flex justify-between text-[10px]">
        <span>{T("PAID BY", "طريقة الدفع")}</span>
        <span dir="ltr">{T("Cash", "نقدي")}</span>
      </div>
      <hr className="my-1 border-black" />
      <div className="text-center font-bold">
        {T("THANK YOU FOR SHOPPING!", "شكراً لتسوقكم معنا")}
      </div>
      {showPol && (
        <div
          dir="auto"
          className="whitespace-pre-wrap mt-1 text-[10px]"
          style={a("returnPolicy")}
        >
          {draft.receiptReturnPolicy}
        </div>
      )}
      {draft.receiptFooterText && (
        <div
          dir="auto"
          className="whitespace-pre-wrap mt-1 text-[10px]"
          style={a("footerText")}
        >
          {draft.receiptFooterText}
        </div>
      )}
      <hr className="my-1 border-black" />
      <div className="text-center font-mono tracking-widest">#{refCode}</div>
    </div>
  );
}

// Alignment helpers — the stored map is intentionally sparse (center entries
// are dropped by the normaliser), so these wrappers smooth over missing keys.
type Align = "left" | "center" | "right";

function alignOf(
  map: Record<string, Align> | undefined,
  key: string,
): Align {
  const v = map?.[key];
  return v === "left" || v === "right" ? v : "center";
}

function withAlign(
  map: Record<string, Align> | undefined,
  key: string,
  value: Align,
): Record<string, Align> {
  const next: Record<string, Align> = { ...(map ?? {}) };
  if (value === "center") {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}

// Labels are populated inside the component from the dictionary — this
// placeholder exists only so the AlignmentPicker type is stable at module
// scope. The component overwrites it with the i18n strings before use.
const ALIGN_LABELS: Record<Align, string> = { left: "Left", center: "Center", right: "Right" };

interface AlignmentPickerProps {
  value: Align;
  onChange: (v: Align) => void;
  labels: Record<Align, string>;
}

function AlignmentPicker({ value, onChange, labels }: AlignmentPickerProps) {
  // Phosphor TextAlign icons — the previous ⯇ ◆ ⯈ glyphs (U+2BC7–8) relied on
  // system-font coverage that's missing on iOS/Android and inconsistent on
  // Linux browsers, rendering as ? boxes. The icons always render.
  const Icon: Record<Align, typeof TextAlignLeft> = {
    left: TextAlignLeft,
    center: TextAlignCenter,
    right: TextAlignRight,
  };
  const options: Align[] = ["left", "center", "right"];
  return (
    <div
      role="radiogroup"
      className="inline-flex rounded-md border border-border overflow-hidden"
    >
      {options.map((opt) => {
        const C = Icon[opt];
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={value === opt}
            aria-label={labels[opt]}
            title={labels[opt]}
            onClick={() => onChange(opt)}
            className={
              "px-2 py-1 leading-none " +
              (value === opt
                ? "bg-accent text-white"
                : "bg-white text-text-secondary hover:bg-bg-main")
            }
          >
            <C className="w-4 h-4" />
          </button>
        );
      })}
    </div>
  );
}

interface IdentityFieldProps {
  label: string;
  placeholder: string;
  value: string;
  maxLength: number;
  multiline?: boolean;
  hint?: string;
  onChange: (v: string) => void;
  /** Optional per-row show/hide toggle — rendered on the label row. */
  showToggle?: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
  };
  /** Optional alignment picker — rendered on the label row next to the toggle. */
  alignment?: {
    value: Align;
    onChange: (v: Align) => void;
  };
}

function IdentityField({
  label,
  placeholder,
  value,
  maxLength,
  multiline,
  hint,
  onChange,
  showToggle,
  alignment,
}: IdentityFieldProps) {
  return (
    <div>
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex-1">
          <label className="block text-sm font-medium text-text-secondary">
            {label}
          </label>
          {hint ? (
            <p className="text-[10px] text-text-secondary mt-0.5">{hint}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {alignment ? (
            <AlignmentPicker
              value={alignment.value}
              onChange={alignment.onChange}
              labels={ALIGN_LABELS}
            />
          ) : null}
          {showToggle ? (
            <ShowToggle
              checked={showToggle.checked}
              onChange={showToggle.onChange}
              label={showToggle.label}
            />
          ) : null}
        </div>
      </div>
      {multiline ? (
        <textarea
          value={value}
          dir="auto"
          rows={2}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      ) : (
        <input
          type="text"
          value={value}
          dir="auto"
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      )}
    </div>
  );
}

/** Small switch — one source for the identity card. Checked = row appears on
 *  the receipt even when text is set; unchecked = row is suppressed but the
 *  typed text stays in the DB so the Owner can bring it back with one tap. */
function ShowToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-1.5 shrink-0 cursor-pointer select-none">
      <span className="text-[10px] text-text-secondary">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={
          "relative inline-flex w-9 h-5 rounded-full transition-colors " +
          (checked ? "bg-accent" : "bg-border")
        }
      >
        <span
          className={
            "absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all " +
            (checked ? "start-[18px]" : "start-0.5")
          }
        />
      </button>
    </label>
  );
}

// Preset slogans — one tap fills the slogan field. Bilingual so the Owner
// can pick the one that matches their receipt language.
const SLOGAN_SUGGESTIONS = [
  "شكراً لتسوقكم معنا",
  "شكراً لثقتكم بنا ❤️",
  "نتمنى زيارتكم مرة أخرى",
  "Thank you for shopping with us",
];
