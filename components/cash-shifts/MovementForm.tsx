"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

type Kind = "paid_in" | "paid_out" | "cash_in" | "cash_out";

interface Props {
  shiftId: string;
  onSaved: () => Promise<void>;
  onCancel: () => void;
  onError: (msg: string) => void;
}

export function MovementForm({ shiftId, onSaved, onCancel, onError }: Props) {
  const dict = useDictionary();
  const t = dict.app.cashShifts.movement;
  const [kind, setKind] = useState<Kind>("paid_in");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const kindOptions: { value: Kind; label: string }[] = [
    { value: "paid_in", label: t.kinds.paid_in },
    { value: "paid_out", label: t.kinds.paid_out },
    { value: "cash_in", label: t.kinds.cash_in },
    { value: "cash_out", label: t.kinds.cash_out },
  ];

  const submit = async () => {
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0) {
      onError(t.invalidAmount);
      return;
    }
    if (!reason.trim()) {
      onError(t.reasonRequired);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/cash-shifts/${shiftId}/movements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, amount: a, reason: reason.trim() }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        onError(json.error || t.errorGeneric);
        return;
      }
      setAmount("");
      setReason("");
      await onSaved();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-border p-3 space-y-3 bg-bg-main/30">
      <Select
        label={t.kindLabel}
        options={kindOptions}
        value={kind}
        onChange={(e) => setKind(e.target.value as Kind)}
      />
      <Input
        label={t.amountLabel}
        type="number"
        inputMode="decimal"
        min={0}
        step="0.01"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <Input
        label={t.reasonLabel}
        placeholder={t.reasonPlaceholder}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex gap-2 justify-end">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={submitting}>
          {t.cancel}
        </Button>
        <Button size="sm" onClick={submit} loading={submitting}>
          {t.submit}
        </Button>
      </div>
    </div>
  );
}
