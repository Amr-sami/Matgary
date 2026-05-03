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
  location: "",
};

export default function AddProductPage() {
  const [step, setStep] = useState(1);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  // attribute_id -> attribute_value_id
  const [attrValues, setAttrValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const { data: categories, loading: catsLoading } = useCategories();
  const { data: attributes } = useCategoryAttributes(categoryId);
  const { data: brands } = useBrands(categoryId);

  // If the chosen category has no attributes, skip step 2 entirely.
  const skipAttributes = !!categoryId && attributes.length === 0;

  useEffect(() => {
    setAttrValues({});
  }, [categoryId]);

  const handleFormChange = (field: string, value: string | number) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleNext = () => {
    if (step === 1) {
      setStep(skipAttributes ? 3 : 2);
    } else if (step === 2) {
      setStep(3);
    }
  };

  const handleBack = () => {
    if (step === 3) {
      setStep(skipAttributes ? 1 : 2);
    } else if (step === 2) {
      setStep(1);
    }
  };

  const allRequiredAttrsAnswered = useMemo(
    () =>
      attributes
        .filter((a) => a.required)
        .every((a) => !!attrValues[a.id]),
    [attributes, attrValues],
  );

  const canProceedFromStep =
    step === 1
      ? !!categoryId
      : step === 2
      ? allRequiredAttrsAnswered
      : true;

  const handleSubmit = async () => {
    if (!categoryId || !form.name || form.quantity < 1 || form.price < 1) return;

    setLoading(true);
    try {
      const productBrand =
        brands.length > 0
          ? form.brand === "Other"
            ? form.customBrand
            : form.brand
          : undefined;

      const tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);

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

      setToast({ type: "success", message: "تم إضافة المنتج بنجاح" });

      // Reset
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

  return (
    <AppShell title="إضافة صنف جديد">
      <div className="max-w-2xl mx-auto space-y-8">
        <StepIndicator currentStep={step} />

        <div className="bg-white rounded-xl p-6 shadow-sm border border-border">
          {step === 1 && (
            <Step1Category
              categories={categories}
              selectedId={categoryId}
              onSelect={setCategoryId}
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

        <div className="flex gap-4">
          <Button
            variant="ghost"
            onClick={handleBack}
            disabled={step === 1}
            className="flex-1"
          >
            السابق
          </Button>
          <Button
            onClick={handleNext}
            disabled={!canProceedFromStep || step === 3}
            className="flex-1"
          >
            التالي
          </Button>
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
