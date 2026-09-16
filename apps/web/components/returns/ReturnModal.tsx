"use client";

import { useMemo, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { recordReturn } from "@/lib/api/returns";
import type { Sale } from "@/lib/types";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface ReturnModalProps {
  isOpen: boolean;
  onClose: () => void;
  sale: Sale | null;
  onSuccess: () => void;
}

type ReturnReasonKey = "defect" | "not_liked" | "wrong_size" | "other";

export function ReturnModal({ isOpen, onClose, sale, onSuccess }: ReturnModalProps) {
  const dict = useDictionary();
  const t = dict.app.sales.returnModal;
  const [loading, setLoading] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState<ReturnReasonKey | "">("");
  const [otherReason, setOtherReason] = useState("");

  const reasonOptions = useMemo(
    () => [
      { value: "defect", label: t.reasons.defect },
      { value: "not_liked", label: t.reasons.not_liked },
      { value: "wrong_size", label: t.reasons.wrong_size },
      { value: "other", label: t.reasons.other },
    ],
    [t.reasons],
  );

  const handleReturn = async () => {
    if (!sale || quantity < 1 || !reason) return;
    setLoading(true);
    try {
      const returnReason =
        reason === "other"
          ? otherReason
          : t.reasons[reason as ReturnReasonKey] || "";
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
    <Modal isOpen={isOpen} onClose={onClose} title={t.title}>
      <div className="space-y-4">
        <div className="p-4 bg-gray-50 rounded-lg">
          <p className="font-medium" dir="auto">{sale.productName}</p>
          <p className="text-sm text-text-secondary">
            {t.sold.replace("{n}", String(sale.quantitySold))}
          </p>
        </div>

        <Input
          label={t.quantity}
          type="number"
          value={quantity}
          onChange={(e) => setQuantity(Number(e.target.value))}
          min={1}
          max={sale.quantitySold}
          error={
            quantity > sale.quantitySold
              ? t.maxQuantity.replace("{n}", String(sale.quantitySold))
              : undefined
          }
        />

        <Select
          label={t.reasonLabel}
          options={reasonOptions}
          value={reason}
          onChange={(e) => setReason(e.target.value as ReturnReasonKey | "")}
          placeholder={t.reasonPlaceholder}
        />

        {reason === "other" && (
          <Input
            label={t.otherLabel}
            value={otherReason}
            onChange={(e) => setOtherReason(e.target.value)}
            placeholder={t.otherPlaceholder}
          />
        )}

        <div className="flex gap-3 pt-4">
          <Button variant="ghost" onClick={onClose} className="flex-1">
            {dict.app.common.cancel}
          </Button>
          <Button
            onClick={handleReturn}
            disabled={quantity < 1 || !reason || (reason === "other" && !otherReason)}
            loading={loading}
            className="flex-1"
          >
            {t.confirm}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
