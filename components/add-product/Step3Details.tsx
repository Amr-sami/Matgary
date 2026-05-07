"use client";

import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { SupplierPicker } from "../suppliers/SupplierPicker";
import { Eye, ListChecks, MapPin, Package, Tag } from "@/lib/icons";
import type { BrandDescriptor } from "@/lib/types";

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

// Money input — regular Input with a non-interactive ج.م suffix layered on
// top. The underlying value stays a plain number.
function MoneyInput({
  label,
  value,
  onChange,
  min = 0,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
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
        ج.م
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
  const previewName = form.name.trim() || "اسم المنتج";

  // Plain <div>, not <form>: SupplierPicker can open a modal with its own
  // <form> inline (Modal renders without a portal), and nested forms are
  // invalid HTML. Submission is the sticky footer button on the page.
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Form column (left, 2/3 on desktop) */}
      <div className="lg:col-span-2 space-y-6">
        <div>
          <h2 className="text-lg font-bold text-text-primary">تفاصيل المنتج</h2>
          <p className="text-sm text-text-secondary mt-0.5">
            راجع التفاصيل قبل الحفظ — تظهر في المعاينة على الجانب.
          </p>
        </div>

        <section className="space-y-4">
          <SectionHeader
            icon={Package}
            title="بيانات أساسية"
            subtitle="ما يظهر للموظف وللعميل في الفاتورة."
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="البراند (اختياري)"
              options={brandOptions.map((b) => ({
                value: b,
                label: b === "Other" ? "أخرى (إضافة براند جديد)" : b,
              }))}
              value={form.brand}
              onChange={(e) => onChange("brand", e.target.value)}
              placeholder="اختر البراند..."
            />
            {form.brand === "Other" ? (
              <Input
                label="اسم البراند الجديد"
                value={form.customBrand}
                onChange={(e) => onChange("customBrand", e.target.value)}
                placeholder="اسم البراند..."
              />
            ) : (
              <div className="hidden sm:block" aria-hidden />
            )}
            <div className="sm:col-span-2">
              <Input
                label="اسم المنتج"
                value={form.name}
                onChange={(e) => onChange("name", e.target.value)}
                placeholder="مثال: ساعة كاجوال جلد بني"
              />
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <SectionHeader
            icon={Tag}
            title="التسعير والمخزون"
            subtitle="سعر الشراء يستخدم لحساب الربح في التقارير."
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <MoneyInput
              label="سعر البيع"
              value={form.price}
              onChange={(v) => onChange("price", v)}
              min={1}
            />
            <MoneyInput
              label="سعر الشراء"
              value={form.costPrice}
              onChange={(v) => onChange("costPrice", v)}
              min={0}
            />
            <Input
              label="الكمية الابتدائية"
              type="number"
              value={form.quantity}
              onChange={(e) => onChange("quantity", Number(e.target.value))}
              min={1}
            />
          </div>
          <Input
            label="حد التنبيه عند انخفاض الكمية"
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
            title="بيانات إضافية"
            subtitle="اختياري — يُحسِّن البحث والتقارير."
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="كود المنتج / باركود"
              value={form.sku}
              onChange={(e) => onChange("sku", e.target.value)}
              placeholder="SKU أو باركود"
            />
            <Input
              label="مكان التخزين"
              value={form.location}
              onChange={(e) => onChange("location", e.target.value)}
              placeholder="رف 3، فاترينة B"
            />
          </div>
          <SupplierPicker
            value={form.supplierId}
            onChange={(id) => onChange("supplierId", id)}
          />
          <Input
            label="تاجات (افصل بفاصلة)"
            value={form.tags}
            onChange={(e) => onChange("tags", e.target.value)}
            placeholder="عرض، جديد، تصفية"
          />
        </section>
      </div>

      {/* Preview column (right, 1/3 on desktop, sticky). */}
      <aside className="lg:col-span-1">
        <div className="lg:sticky lg:top-6">
          <div className="bg-bg-main/40 rounded-2xl p-5 border border-border">
            <p className="text-xs text-text-secondary mb-3 flex items-center gap-1.5">
              <Eye className="w-3.5 h-3.5" />
              معاينة سريعة
            </p>

            <div className="bg-white rounded-xl p-4 border border-border shadow-sm">
              {previewBrand && (
                <p className="text-[11px] uppercase tracking-wide text-accent font-bold mb-1">
                  {previewBrand}
                </p>
              )}
              <h4 className="text-base font-bold text-text-primary leading-snug">
                {previewName}
              </h4>

              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-2xl font-extrabold text-text-primary">
                  {form.price > 0 ? form.price.toLocaleString("ar-EG") : "—"}
                </span>
                <span className="text-xs text-text-secondary">ج.م</span>
              </div>

              {form.costPrice > 0 && (
                <p className="text-[11px] text-text-secondary mt-0.5">
                  سعر الشراء: {form.costPrice.toLocaleString("ar-EG")} ج.م
                </p>
              )}

              <div className="mt-4 grid grid-cols-2 gap-2 text-[11px]">
                <div className="bg-bg-main rounded-lg px-2.5 py-1.5">
                  <p className="text-text-secondary">الكمية</p>
                  <p className="font-bold text-text-primary mt-0.5">
                    {form.quantity || 0}
                  </p>
                </div>
                <div className="bg-bg-main rounded-lg px-2.5 py-1.5">
                  <p className="text-text-secondary">حد التنبيه</p>
                  <p className="font-bold text-text-primary mt-0.5">
                    {form.lowStockThreshold || 0}
                  </p>
                </div>
              </div>

              {margin != null && marginPct != null && (
                <div className="mt-3 flex items-center justify-between bg-success-light/60 rounded-lg px-3 py-2">
                  <span className="text-[11px] font-medium text-success">
                    هامش الربح
                  </span>
                  <span className="text-sm font-bold text-success">
                    {margin.toLocaleString("ar-EG")} ج.م
                    <span className="text-[11px] font-normal mx-1 opacity-80">
                      ({marginPct.toFixed(0)}%)
                    </span>
                  </span>
                </div>
              )}

              {form.location && (
                <p className="mt-3 text-[11px] text-text-secondary flex items-center gap-1">
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
              تتغير المعاينة لحظياً مع كل حقل تكمله.
            </p>
          </div>
        </div>
      </aside>
    </div>
  );
}
