"use client";

import { useState, useEffect } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { SupplierPicker } from "../suppliers/SupplierPicker";
import { updateProduct } from "@/lib/api/products";
import type { Product } from "@/lib/types";

interface EditProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  product: Product | null;
  onSuccess: () => void;
}

export function EditProductModal({
  isOpen,
  onClose,
  product,
  onSuccess,
}: EditProductModalProps) {
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [quantity, setQuantity] = useState(0);
  const [price, setPrice] = useState(0);
  const [costPrice, setCostPrice] = useState(0);
  const [lowStockThreshold, setLowStockThreshold] = useState(3);
  const [sku, setSku] = useState("");
  const [tags, setTags] = useState("");
  const [supplier, setSupplier] = useState("");
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [location, setLocation] = useState("");

  useEffect(() => {
    if (product && isOpen) {
      setName(product.name);
      setBrand(product.brand || "");
      setQuantity(product.quantity);
      setPrice(product.price);
      setCostPrice(product.costPrice || 0);
      setLowStockThreshold(product.lowStockThreshold || 3);
      setSku(product.sku || "");
      setTags((product.tags || []).join(", "));
      setSupplier(product.supplier || "");
      setSupplierId(product.supplierId ?? null);
      setLocation(product.location || "");
    }
  }, [product, isOpen]);

  const handleSave = async () => {
    if (!product) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      alert("اسم المنتج مطلوب");
      return;
    }
    setLoading(true);
    try {
      const tagList = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await updateProduct(product.id, {
        name: trimmedName,
        brand: brand.trim(),
        quantity: Number(quantity),
        price: Number(price),
        costPrice: Number(costPrice),
        lowStockThreshold: Number(lowStockThreshold),
        sku: sku.trim(),
        // When a supplier is linked, clear the legacy free-text field so it
        // doesn't shadow the FK on next read.
        supplier: supplierId ? "" : supplier.trim(),
        supplierId,
        location: location.trim(),
        tags: tagList,
      });
      onSuccess();
      onClose();
    } catch (error) {
      console.error(error);
      alert("حدث خطأ أثناء التحديث");
    } finally {
      setLoading(false);
    }
  };

  if (!product) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="تعديل المنتج">
      <div className="space-y-4">
        <Input
          label="اسم المنتج"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <Input
          label="الماركة"
          type="text"
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
        />

        <Input
          label="الكمية"
          type="number"
          value={quantity}
          onChange={(e) => setQuantity(Number(e.target.value))}
          min={0}
        />

        <Input
          label="سعر البيع (جنيه)"
          type="number"
          value={price}
          onChange={(e) => setPrice(Number(e.target.value))}
          min={0}
        />

        <Input
          label="سعر الشراء (جنيه)"
          type="number"
          value={costPrice}
          onChange={(e) => setCostPrice(Number(e.target.value))}
          min={0}
        />

        <Input
          label="حد التنبيه عند انخفاض الكمية"
          type="number"
          value={lowStockThreshold}
          onChange={(e) => setLowStockThreshold(Number(e.target.value))}
          min={1}
        />

        <Input
          label="كود المنتج / الباركود"
          type="text"
          value={sku}
          onChange={(e) => setSku(e.target.value)}
        />

        <SupplierPicker
          value={supplierId}
          onChange={setSupplierId}
          label="المورد"
        />
        {!supplierId && supplier && (
          <Input
            label="المورد (نص قديم)"
            type="text"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
          />
        )}

        <Input
          label="مكان التخزين"
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />

        <Input
          label="تاجات (افصل بفاصلة)"
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="عرض، جديد، تصفية"
        />

        <div className="flex gap-3 pt-4">
          <Button variant="ghost" onClick={onClose} className="flex-1">
            إلغاء
          </Button>
          <Button onClick={handleSave} loading={loading} className="flex-1">
            حفظ
          </Button>
        </div>
      </div>
    </Modal>
  );
}
