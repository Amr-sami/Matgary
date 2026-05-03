"use client";

import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { recordReturn } from "@/lib/api/returns";
import type { Sale } from "@/lib/types";

interface ReturnModalProps {
  isOpen: boolean;
  onClose: () => void;
  sale: Sale | null;
  onSuccess: () => void;
}

const RETURN_REASONS = [
  { value: "defect", label: "عيب في المنتج" },
  { value: "not_liked", label: "المنتج لم يعجب العميل" },
  { value: "wrong_size", label: "حجم غير مناسب" },
  { value: "other", label: "أخرى" },
];

export function ReturnModal({ isOpen, onClose, sale, onSuccess }: ReturnModalProps) {
  const [loading, setLoading] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState("");
  const [otherReason, setOtherReason] = useState("");

  const handleReturn = async () => {
    if (!sale || quantity < 1 || !reason) return;
    setLoading(true);
    try {
      const returnReason =
        reason === "other" ? otherReason : RETURN_REASONS.find((r) => r.value === reason)?.label || "";
      await recordReturn(sale.id, sale.productId, quantity, returnReason);
      onSuccess();
      onClose();
      setQuantity(1);
      setReason("");
      setOtherReason("");
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  if (!sale) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="تسجيل مرتجع">
      <div className="space-y-4">
        <div className="p-4 bg-gray-50 rounded-lg">
          <p className="font-medium">{sale.productName}</p>
          <p className="text-sm text-text-secondary">المباع: {sale.quantitySold} قطعة</p>
        </div>

        <Input
          label="الكمية المرتجعة"
          type="number"
          value={quantity}
          onChange={(e) => setQuantity(Number(e.target.value))}
          min={1}
          max={sale.quantitySold}
          error={
            quantity > sale.quantitySold
              ? `الحد الأقصى: ${sale.quantitySold}`
              : undefined
          }
        />

        <Select
          label="سبب الإرجاع"
          options={RETURN_REASONS}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="اختر السبب..."
        />

        {reason === "other" && (
          <Input
            label="اكتب السبب"
            value={otherReason}
            onChange={(e) => setOtherReason(e.target.value)}
            placeholder="سبب الإرجاع..."
          />
        )}

        <div className="flex gap-3 pt-4">
          <Button variant="ghost" onClick={onClose} className="flex-1">
            إلغاء
          </Button>
          <Button
            onClick={handleReturn}
            disabled={quantity < 1 || !reason || (reason === "other" && !otherReason)}
            loading={loading}
            className="flex-1"
          >
            تأكيد الإرجاع
          </Button>
        </div>
      </div>
    </Modal>
  );
}