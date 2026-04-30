"use client";

import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { StepIndicator } from "@/components/add-product/StepIndicator";
import { Step1Category } from "@/components/add-product/Step1Category";
import { Step2Gender } from "@/components/add-product/Step2Gender";
import { Step3Details } from "@/components/add-product/Step3Details";
import { Button } from "@/components/ui/Button";
import { Toast } from "@/components/ui/Toast";
import { addProduct } from "@/lib/firestore";
import type { Category, Gender } from "@/lib/types";

export default function AddProductPage() {
  const [step, setStep] = useState(1);
  const [category, setCategory] = useState<Category | null>(null);
  const [gender, setGender] = useState<Gender | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const [form, setForm] = useState({
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
  });

  const handleFormChange = (field: string, value: string | number) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleNext = () => {
    if (step < 3) setStep(step + 1);
  };

  const handleBack = () => {
    if (step > 1) setStep(step - 1);
  };

  const handleSubmit = async () => {
    if (!category || !gender || !form.name || form.quantity < 1 || form.price < 1) return;

    setLoading(true);
    try {
      const productBrand = category === "watches"
        ? (form.brand === "Other" ? form.customBrand : form.brand)
        : undefined;

      const tags = form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      const payload: any = {
        name: form.name,
        category,
        gender,
        brand: productBrand,
        quantity: form.quantity,
        price: form.price,
        costPrice: form.costPrice || undefined,
        lowStockThreshold: form.lowStockThreshold,
      };
      if (form.sku.trim()) payload.sku = form.sku.trim();
      if (form.supplier.trim()) payload.supplier = form.supplier.trim();
      if (form.location.trim()) payload.location = form.location.trim();
      if (tags.length > 0) payload.tags = tags;

      await addProduct(payload);

      setToast({ type: "success", message: "تم إضافة المنتج بنجاح" });

      setStep(1);
      setCategory(null);
      setGender(null);
      setForm({
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
      });
    } catch (error: any) {
      setToast({ type: "error", message: error.message || "حدث خطأ" });
    } finally {
      setLoading(false);
    }
  };

  const canProceed = step === 1 ? !!category : step === 2 ? !!gender : true;

  return (
    <AppShell title="إضافة صنف جديد">
      <div className="max-w-2xl mx-auto space-y-8">
        <StepIndicator currentStep={step} />

        <div className="bg-white rounded-xl p-6 shadow-sm border border-border">
          {step === 1 && (
            <Step1Category selected={category} onSelect={setCategory} />
          )}

          {step === 2 && (
            <Step2Gender selected={gender} onSelect={setGender} />
          )}

          {step === 3 && category && gender && (
            <Step3Details
              category={category}
              gender={gender}
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
            disabled={!canProceed || step === 3}
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