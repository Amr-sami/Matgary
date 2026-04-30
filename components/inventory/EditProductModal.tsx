"use client";

import { useState, useEffect } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { updateProduct } from "@/lib/firestore";
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
  const [quantity, setQuantity] = useState(0);
  const [price, setPrice] = useState(0);
  const [costPrice, setCostPrice] = useState(0);
  const [lowStockThreshold, setLowStockThreshold] = useState(3);

  // Update state when product prop changes or modal opens
  useEffect(() => {
    if (product && isOpen) {
      setName(product.name);
      setQuantity(product.quantity);
      setPrice(product.price);
      setCostPrice(product.costPrice || 0);
      setLowStockThreshold(product.lowStockThreshold || 3);
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
      await updateProduct(product.id, {
        name: trimmedName,
        quantity: Number(quantity),
        price: Number(price),
        costPrice: Number(costPrice),
        lowStockThreshold: Number(lowStockThreshold),
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
        {product.brand && (
          <div className="p-4 bg-gray-50 rounded-lg">
            <p className="text-sm text-text-secondary">{product.brand}</p>
          </div>
        )}

        <Input
          label="اسم المنتج"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
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