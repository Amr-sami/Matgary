"use client";

import { useState } from "react";
import { Wallet } from "@/lib/icons";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onOpened: () => Promise<void>;
  onError: (msg: string) => void;
}

export function OpenShiftModal({ isOpen, onClose, onOpened, onError }: Props) {
  const dict = useDictionary();
  const t = dict.app.cashShifts.openModal;
  const [openingFloat, setOpeningFloat] = useState<string>("0");
  const [note, setNote] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const f = Number(openingFloat);
    if (!Number.isFinite(f) || f < 0) {
      onError(t.invalidFloat);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/cash-shifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          openingFloat: f,
          openingNote: note.trim() || null,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        onError(json.error || t.errorGeneric);
        return;
      }
      setOpeningFloat("0");
      setNote("");
      await onOpened();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t.title}>
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">{t.intro}</p>
        <Input
          label={t.floatLabel}
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={openingFloat}
          onChange={(e) => setOpeningFloat(e.target.value)}
          autoFocus
        />
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            {t.noteLabel}
          </label>
          <textarea
            dir="auto"
            rows={2}
            placeholder={t.notePlaceholder}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg border border-border bg-white text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
          />
        </div>
        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t.cancel}
          </Button>
          <Button onClick={submit} loading={submitting}>
            <Wallet className="w-4 h-4 me-1" />
            {t.submit}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
