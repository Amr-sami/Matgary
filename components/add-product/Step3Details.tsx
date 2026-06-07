"use client";

import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { SupplierPicker } from "../suppliers/SupplierPicker";
import { Eye, ListChecks, MapPin, Package, Tag } from "@/lib/icons";
import type { BrandDescriptor } from "@/lib/types";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";

interface Step3DetailsProps {
  brands: BrandDescriptor[];
  form: {
    brand: string;
    customBrand: string;
    name: string;
    quantity: number;
    price: number;
    costPrice: number;
    lowStockThreshold: number;
    sku: string;
    tags: string;
    supplier: string;
    supplierId: string | null;
    location: string;
  };
  onChange: (field: string, value: string | number | null) => void;
  /** Submit moved to the page footer; kept here so Enter inside a field
   *  still saves (the form element calls preventDefault + onSubmit). */
  onSubmit: () => void;
  loading: boolean;
}

// Compact section header — small accent icon + bold title + helper line.
function SectionHeader({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex items-start gap-2.5 mb-3">
      <Icon className="w-5 h-5 text-accent mt-0.5 shrink-0" />
      <div>
        <h3 className="text-sm font-semibold text-text-primary leading-tight">
          {title}
        </h3>
        {subtitle && (
          <p className="text-xs text-text-secondary mt-0.5">{subtitle}</p>
        )}
      </div>
    </div>
  );
}

// Money input — regular Input with a non-interactive currency suffix layered
// on top. The underlying value stays a plain number.
function MoneyInput({
  label,
  value,
  onChange,
  min = 0,
  currencySuffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  currencySuffix: string;
}) {
  return (
    <div className="relative">
      <Input
        label={label}
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        min={min}
        className="pe-12"
      />
      <span className="pointer-events-none absolute end-4 top-[34px] text-xs font-medium text-text-secondary">
        {currencySuffix}
      </span>
    </div>
  );
}

export function Step3Details({
  brands,
  form,
  onChange,
  onSubmit,
  loading,
}: Step3DetailsProps) {
  void onSubmit;
  void loading; // submission lives in the page's sticky footer
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.inventory.addProduct.step3;

  const brandOptions = [
    ...brands.map((b) => b.name).filter((n) => n.toLowerCase() !== "other"),
    "Other",
  ];

  // Computed: margin (sale - cost) — purely informational, drives the
  // success chip in the live preview.
  const margin =
    form.price > 0 && form.costPrice > 0 ? form.price - form.costPrice : null;
  const marginPct =
    margin != null && form.price > 0 ? (margin / form.price) * 100 : null;

  const previewBrand =
    form.brand === "Other" ? form.customBrand.trim() : form.brand.trim();
  const previewName = form.name.trim() || t.preview.namePlaceholder;

  // Plain <div>, not <form>: SupplierPicker can open a modal with its own
  // <form> inline (Modal renders without a portal), and nested forms are
  // invalid HTML. Submission is the sticky footer button on the page.
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Form column (left, 2/3 on desktop) */}
      <div className="lg:col-span-2 space-y-6">
        <div>
          <h2 className="text-lg font-bold text-text-primary">{t.heading}</h2>
          <p className="text-sm text-text-secondary mt-0.5">
            {t.subhead}
          </p>
        </div>

        <section className="space-y-4">
          <SectionHeader
            icon={Package}
            title={t.sections.basics.title}
            subtitle={t.sections.basics.subtitle}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label={t.fields.brand}
              options={brandOptions.map((b) => ({
                value: b,
                label: b === "Other" ? t.fields.brandOther : b,
              }))}
              value={form.brand}
              onChange={(e) => onChange("brand", e.target.value)}
              placeholder={t.fields.brandPlaceholder}
            />
            {form.brand === "Other" ? (
              <Input
                label={t.fields.newBrand}
                value={form.customBrand}
                onChange={(e) => onChange("customBrand", e.target.value)}
                placeholder={t.fields.newBrandPlaceholder}
              />
            ) : (
              <div className="hidden sm:block" aria-hidden />
            )}
            <div className="sm:col-span-2">
              <Input
                label={t.fields.name}
                value={form.name}
                onChange={(e) => onChange("name", e.target.value)}
                placeholder={t.fields.namePlaceholder}
              />
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <SectionHeader
            icon={Tag}
            title={t.sections.pricing.title}
            subtitle={t.sections.pricing.subtitle}
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <MoneyInput
              label={t.fields.price}
              value={form.price}
              onChange={(v) => onChange("price", v)}
              min={1}
              currencySuffix={t.fields.currencySuffix}
            />
            <MoneyInput
              label={t.fields.costPrice}
              value={form.costPrice}
              onChange={(v) => onChange("costPrice", v)}
              min={0}
              currencySuffix={t.fields.currencySuffix}
            />
            <Input
              label={t.fields.quantity}
              type="number"
              value={form.quantity}
              onChange={(e) => onChange("quantity", Number(e.target.value))}
              min={1}
            />
          </div>
          <Input
            label={t.fields.lowStockThreshold}
            type="number"
            value={form.lowStockThreshold}
            onChange={(e) =>
              onChange("lowStockThreshold", Number(e.target.value))
            }
            min={1}
          />
        </section>

        <section className="space-y-4">
          <SectionHeader
            icon={ListChecks}
            title={t.sections.extras.title}
            subtitle={t.sections.extras.subtitle}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label={t.fields.sku}
              value={form.sku}
              onChange={(e) => onChange("sku", e.target.value)}
              placeholder={t.fields.skuPlaceholder}
            />
            <Input
              label={t.fields.location}
              value={form.location}
              onChange={(e) => onChange("location", e.target.value)}
              placeholder={t.fields.locationPlaceholder}
            />
          </div>
          <SupplierPicker
            value={form.supplierId}
            onChange={(id) => onChange("supplierId", id)}
          />
          <Input
            label={t.fields.tags}
            value={form.tags}
            onChange={(e) => onChange("tags", e.target.value)}
            placeholder={t.fields.tagsPlaceholder}
          />
        </section>
      </div>

      {/* Preview column (right, 1/3 on desktop, sticky). */}
      <aside className="lg:col-span-1">
        <div className="lg:sticky lg:top-6">
          <div className="bg-bg-main/40 rounded-2xl p-5 border border-border">
            <p className="text-xs text-text-secondary mb-3 flex items-center gap-1.5">
              <Eye className="w-3.5 h-3.5" />
              {t.preview.title}
            </p>

            <div className="bg-white rounded-xl p-4 border border-border shadow-sm">
              {previewBrand && (
                <p className="text-[11px] uppercase tracking-wide text-accent font-bold mb-1" dir="auto">
                  {previewBrand}
                </p>
              )}
              <h4 className="text-base font-bold text-text-primary leading-snug" dir="auto">
                {previewName}
              </h4>

              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-2xl font-extrabold text-text-primary">
                  {form.price > 0 ? formatCurrency(form.price, locale) : "—"}
                </span>
              </div>

              {form.costPrice > 0 && (
                <p className="text-[11px] text-text-secondary mt-0.5">
                  {t.preview.costLine.replace(
                    "{cost}",
                    formatCurrency(form.costPrice, locale),
                  )}
                </p>
              )}

              <div className="mt-4 grid grid-cols-2 gap-2 text-[11px]">
                <div className="bg-bg-main rounded-lg px-2.5 py-1.5">
                  <p className="text-text-secondary">{t.preview.quantity}</p>
                  <p className="font-bold text-text-primary mt-0.5">
                    {form.quantity || 0}
                  </p>
                </div>
                <div className="bg-bg-main rounded-lg px-2.5 py-1.5">
                  <p className="text-text-secondary">{t.preview.lowStock}</p>
                  <p className="font-bold text-text-primary mt-0.5">
                    {form.lowStockThreshold || 0}
                  </p>
                </div>
              </div>

              {margin != null && marginPct != null && (
                <div className="mt-3 flex items-center justify-between bg-success-light/60 rounded-lg px-3 py-2">
                  <span className="text-[11px] font-medium text-success">
                    {t.preview.margin}
                  </span>
                  <span className="text-sm font-bold text-success">
                    {formatCurrency(margin, locale)}
                    <span className="text-[11px] font-normal mx-1 opacity-80">
                      ({marginPct.toFixed(0)}%)
                    </span>
                  </span>
                </div>
              )}

              {form.location && (
                <p className="mt-3 text-[11px] text-text-secondary flex items-center gap-1" dir="auto">
                  <MapPin className="w-3.5 h-3.5" />
                  {form.location}
                </p>
              )}

              {form.sku && (
                <p
                  className="mt-1 text-[11px] text-text-secondary font-mono"
                  dir="ltr"
                >
                  {form.sku}
                </p>
              )}
            </div>

            <p className="text-[11px] text-text-secondary mt-3 leading-relaxed">
              {t.preview.footnote}
            </p>
          </div>
        </div>
      </aside>
    </div>
  );
}
