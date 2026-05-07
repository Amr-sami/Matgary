"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { StepIndicator } from "@/components/add-product/StepIndicator";
import { Step1Category } from "@/components/add-product/Step1Category";
import { Step2Attributes } from "@/components/add-product/Step2Attributes";
import { Step3Details } from "@/components/add-product/Step3Details";
import { Button } from "@/components/ui/Button";
import { Toast } from "@/components/ui/Toast";
import { useCategories } from "@/hooks/useCategories";
import { useCategoryAttributes } from "@/hooks/useCategoryAttributes";
import { useBrands } from "@/hooks/useBrands";
import { ChevronRight, ChevronLeft } from "@/lib/icons";

const EMPTY_FORM = {
  brand: "",
  customBrand: "",
  name: "",
  quantity: 1,
  price: 0,
  costPrice: 0,
  lowStockThreshold: 3,
  sku: "",
  tags: "",
  supplier: "",
  supplierId: null as string | null,
  location: "",
};

export default function AddProductPage() {
  const [step, setStep] = useState(1);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  // attribute_id -> attribute_value_id
  const [attrValues, setAttrValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<
    { type: "success" | "error"; message: string } | null
  >(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const {
    data: categories,
    loading: catsLoading,
    refresh: refreshCategories,
  } = useCategories();
  const { data: attributes } = useCategoryAttributes(categoryId);
  const { data: brands, refresh: refreshBrands } = useBrands(categoryId);

  // If the chosen category has no attributes, skip step 2 entirely.
  const skipAttributes = !!categoryId && attributes.length === 0;

  useEffect(() => {
    setAttrValues({});
  }, [categoryId]);

  const handleFormChange = (field: string, value: string | number | null) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleNext = () => {
    if (step === 1) setStep(skipAttributes ? 3 : 2);
    else if (step === 2) setStep(3);
  };

  const handleBack = () => {
    if (step === 3) setStep(skipAttributes ? 1 : 2);
    else if (step === 2) setStep(1);
  };

  const allRequiredAttrsAnswered = useMemo(
    () =>
      attributes.filter((a) => a.required).every((a) => !!attrValues[a.id]),
    [attributes, attrValues],
  );

  const canProceedFromStep =
    step === 1 ? !!categoryId : step === 2 ? allRequiredAttrsAnswered : true;

  const canSubmit =
    step === 3 &&
    !!categoryId &&
    !!form.name.trim() &&
    form.quantity >= 1 &&
    form.price >= 1 &&
    !(form.brand === "Other" && !form.customBrand.trim());

  const handleSubmit = async () => {
    if (!canSubmit || !categoryId) return;

    setLoading(true);
    try {
      const typedBrand =
        form.brand === "Other" ? form.customBrand.trim() : form.brand.trim();
      const productBrand = typedBrand || undefined;

      const tags = form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      const payload = {
        name: form.name,
        categoryId,
        brand: productBrand,
        quantity: form.quantity,
        price: form.price,
        costPrice: form.costPrice || undefined,
        lowStockThreshold: form.lowStockThreshold,
        sku: form.sku.trim() || undefined,
        supplier: form.supplier.trim() || undefined,
        supplierId: form.supplierId || undefined,
        location: form.location.trim() || undefined,
        tags: tags.length > 0 ? tags : undefined,
        attributeValueIds: Object.values(attrValues),
      };

      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      // If the user typed a brand that isn't in the dropdown yet, register it
      // for this category so it appears in future add-product sessions.
      if (form.brand === "Other" && typedBrand) {
        const known = brands.some(
          (b) => b.name.toLowerCase() === typedBrand.toLowerCase(),
        );
        if (!known) {
          await fetch("/api/brands", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: typedBrand, categoryId }),
          }).catch(() => {});
          await refreshBrands();
        }
      }

      setToast({ type: "success", message: "تم إضافة المنتج بنجاح" });

      // Reset for the next entry. Cashiers add many products in a row, so
      // we keep the user on the page rather than redirecting.
      setStep(1);
      setCategoryId(null);
      setAttrValues({});
      setForm(EMPTY_FORM);
    } catch (error) {
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "حدث خطأ",
      });
    } finally {
      setLoading(false);
    }
  };

  const isFinalStep = step === 3;

  return (
    <AppShell title="إضافة صنف جديد">
      <div className="max-w-6xl mx-auto pb-24">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-text-primary leading-tight">
            إضافة منتج جديد
          </h1>
          <p className="text-sm text-text-secondary mt-1">
            ثلاث خطوات سريعة: اختر القسم، حدِّد الخصائص، ثم أكمل التفاصيل.
          </p>
        </header>

        <div className="mb-6">
          <StepIndicator currentStep={step} skipStep2={skipAttributes} />
        </div>

        <div className="bg-white rounded-2xl p-5 sm:p-6 border border-border shadow-sm">
          {step === 1 && (
            <Step1Category
              categories={categories}
              selectedId={categoryId}
              onSelect={setCategoryId}
              onCategoryCreated={async () => {
                await refreshCategories();
              }}
              loading={catsLoading}
            />
          )}

          {step === 2 && (
            <Step2Attributes
              attributes={attributes}
              selected={attrValues}
              onSelect={(attrId, valueId) =>
                setAttrValues((prev) => ({ ...prev, [attrId]: valueId }))
              }
            />
          )}

          {step === 3 && categoryId && (
            <Step3Details
              brands={brands}
              form={form}
              onChange={handleFormChange}
              onSubmit={handleSubmit}
              loading={loading}
            />
          )}
        </div>
      </div>

      {/* Sticky action footer — keeps Back / Next / Save anchored at the
          bottom regardless of scroll. Replaces the duplicate submit button
          that lived inside Step 3 and the loose ghost-pair below the card. */}
      <div
        className="fixed bottom-0 inset-x-0 lg:ms-52 z-30 bg-white/95 backdrop-blur border-t border-border px-4 py-3 lg:py-3.5"
        style={{
          paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)",
        }}
      >
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
          <Button
            variant="ghost"
            onClick={handleBack}
            disabled={step === 1}
            type="button"
          >
            <ChevronRight className="w-4 h-4 ms-1" />
            السابق
          </Button>

          <p className="text-xs text-text-secondary hidden sm:block">
            {isFinalStep
              ? "جاهز للحفظ؟ راجع المعاينة على الجانب."
              : `الخطوة ${step} من 3`}
          </p>

          {isFinalStep ? (
            <Button
              onClick={handleSubmit}
              loading={loading}
              disabled={!canSubmit}
            >
              حفظ المنتج
            </Button>
          ) : (
            <Button
              onClick={handleNext}
              disabled={!canProceedFromStep}
              type="button"
            >
              التالي
              <ChevronLeft className="w-4 h-4 me-1" />
            </Button>
          )}
        </div>
      </div>

      {toast && (
        <Toast
          type={toast.type}
          message={toast.message}
          onClose={() => setToast(null)}
        />
      )}
    </AppShell>
  );
}
