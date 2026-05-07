"use client";

import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { SupplierPicker } from "../suppliers/SupplierPicker";
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
  onSubmit: () => void;
  loading: boolean;
}

export function Step3Details({
  brands,
  form,
  onChange,
  onSubmit,
  loading,
}: Step3DetailsProps) {
  const brandOptions = [
    ...brands.map((b) => b.name).filter((n) => n.toLowerCase() !== "other"),
    "Other",
  ];

  return (
    <div className="space-y-4 max-w-md mx-auto">
      <h3 className="text-center font-semibold mb-6">تفاصيل المنتج</h3>

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

      {form.brand === "Other" && (
        <Input
          label="أدخل اسم البراند"
          value={form.customBrand}
          onChange={(e) => onChange("customBrand", e.target.value)}
          placeholder="اسم البراند..."
        />
      )}

      <Input
        label="اسم المنتج"
        value={form.name}
        onChange={(e) => onChange("name", e.target.value)}
        placeholder="أدخل اسم المنتج..."
      />

      <Input
        label="الكمية"
        type="number"
        value={form.quantity}
        onChange={(e) => onChange("quantity", Number(e.target.value))}
        min={1}
      />

      <Input
        label="سعر البيع (جنيه)"
        type="number"
        value={form.price}
        onChange={(e) => onChange("price", Number(e.target.value))}
        min={1}
      />

      <Input
        label="سعر الشراء (جنيه)"
        type="number"
        value={form.costPrice}
        onChange={(e) => onChange("costPrice", Number(e.target.value))}
        min={0}
      />

      <Input
        label="حد التنبيه عند انخفاض الكمية"
        type="number"
        value={form.lowStockThreshold}
        onChange={(e) => onChange("lowStockThreshold", Number(e.target.value))}
        min={1}
      />

      <Input
        label="كود المنتج / الباركود (اختياري)"
        value={form.sku}
        onChange={(e) => onChange("sku", e.target.value)}
        placeholder="SKU أو باركود"
      />

      <SupplierPicker
        value={form.supplierId}
        onChange={(id) => onChange("supplierId", id)}
      />

      <Input
        label="مكان التخزين (اختياري)"
        value={form.location}
        onChange={(e) => onChange("location", e.target.value)}
        placeholder="مثال: رف 3، فاترينة B"
      />

      <Input
        label="تاجات (افصل بفاصلة)"
        value={form.tags}
        onChange={(e) => onChange("tags", e.target.value)}
        placeholder="مثلاً: عرض، جديد، تصفية"
      />

      <div className="pt-4">
        <Button
          onClick={onSubmit}
          loading={loading}
          disabled={
            !form.name ||
            form.quantity < 1 ||
            form.price < 1 ||
            (form.brand === "Other" && !form.customBrand)
          }
          className="w-full"
        >
          حفظ المنتج
        </Button>
      </div>
    </div>
  );
}
