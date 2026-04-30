"use client";

import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { updateSale } from "@/lib/firestore";
import type { Sale, DiscountType } from "@/lib/types";
import { formatPrice } from "@/lib/utils";

interface EditSaleModalProps {
  isOpen: boolean;
  onClose: () => void;
  sale: Sale | null;
  onSuccess: () => void;
}

export function EditSaleModal({ isOpen, onClose, sale, onSuccess }: EditSaleModalProps) {
  const [quantity, setQuantity] = useState(1);
  const [pricePerUnit, setPricePerUnit] = useState(0);
  const [discountType, setDiscountType] = useState<DiscountType>("percentage");
  const [discountValue, setDiscountValue] = useState(0);
  const [note, setNote] = useState("");
  const [date, setDate] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (sale && isOpen) {
      setQuantity(sale.quantitySold);
      setPricePerUnit(sale.pricePerUnit);
      setDiscountType(sale.discountType || "percentage");
      setDiscountValue(sale.discountValue || 0);
      setNote(sale.note || "");
      setDate(new Date(sale.saleDate).toISOString().slice(0, 10));
    }
  }, [sale, isOpen]);

  if (!sale) return null;

  const subtotal = quantity * pricePerUnit;
  const discountAmount =
    discountValue > 0
      ? discountType === "percentage"
        ? Math.round((subtotal * discountValue) / 100)
        : Math.min(discountValue, subtotal)
      : 0;
  const totalPrice = subtotal - discountAmount;

  const handleSave = async () => {
    setLoading(true);
    try {
      const parsed = date ? new Date(`${date}T12:00:00`) : undefined;
      await updateSale(sale.id, {
        quantitySold: quantity,
        pricePerUnit,
        discountType: discountValue > 0 ? discountType : null,
        discountValue: discountValue > 0 ? discountValue : null,
        note,
        saleDate: parsed,
      });
      onSuccess();
      onClose();
    } catch (e: any) {
      alert(e.message || "تعذر تحديث الفاتورة");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`تعديل البيع: ${sale.productName}`}>
      <div className="space-y-4">
        <Input
          label="الكمية"
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(Number(e.target.value))}
        />
        <Input
          label="سعر الوحدة"
          type="number"
          min={0}
          value={pricePerUnit}
          onChange={(e) => setPricePerUnit(Number(e.target.value))}
        />
        <div className="space-y-2 p-3 bg-gray-50 rounded-lg">
          <div className="flex rounded-lg overflow-hidden border border-border">
            <button
              type="button"
              onClick={() => setDiscountType("percentage")}
              className={`flex-1 py-2 text-sm ${
                discountType === "percentage"
                  ? "bg-accent text-white"
                  : "bg-white text-text-secondary"
              }`}
            >
              نسبة %
            </button>
            <button
              type="button"
              onClick={() => setDiscountType("fixed")}
              className={`flex-1 py-2 text-sm ${
                discountType === "fixed"
                  ? "bg-accent text-white"
                  : "bg-white text-text-secondary"
              }`}
            >
              مبلغ ثابت
            </button>
          </div>
          <Input
            label="قيمة الخصم"
            type="number"
            min={0}
            value={discountValue}
            onChange={(e) => setDiscountValue(Number(e.target.value))}
          />
        </div>
        <div>
          <label className="block text-sm text-text-secondary mb-1.5">تاريخ الفاتورة</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm"
          />
        </div>
        <Input
          label="ملاحظة"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <div className="p-3 bg-accent-light rounded-lg text-sm space-y-1">
          <div className="flex justify-between">
            <span className="text-text-secondary">المجموع الفرعي</span>
            <span>{formatPrice(subtotal)}</span>
          </div>
          {discountAmount > 0 && (
            <div className="flex justify-between text-danger">
              <span>الخصم</span>
              <span>- {formatPrice(discountAmount)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold border-t border-accent/20 pt-1">
            <span>الإجمالي</span>
            <span className="text-accent">{formatPrice(totalPrice)}</span>
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          <Button variant="ghost" onClick={onClose} className="flex-1">
            إلغاء
          </Button>
          <Button onClick={handleSave} loading={loading} className="flex-1">
            حفظ التعديلات
          </Button>
        </div>
      </div>
    </Modal>
  );
}
