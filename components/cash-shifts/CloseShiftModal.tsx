"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface Props {
  isOpen: boolean;
  shiftId: string;
  expectedCash: string;
  onClose: () => void;
  onClosed: () => Promise<void>;
  onError: (msg: string) => void;
}

const fmt = (s: string | number | null | undefined) =>
  s == null
    ? "—"
    : Number(s).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

export function CloseShiftModal({
  isOpen,
  shiftId,
  expectedCash,
  onClose,
  onClosed,
  onError,
}: Props) {
  const router = useRouter();
  const dict = useDictionary();
  const t = dict.app.cashShifts.closeModal;
  const [counted, setCounted] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  const expected = Number(expectedCash);
  const countedN = counted === "" ? null : Number(counted);
  const variance =
    countedN != null && Number.isFinite(countedN) ? countedN - expected : null;
  const tone =
    variance == null
      ? "neutral"
      : Math.abs(variance) < 1
        ? "good"
        : variance < 0
          ? "bad"
          : "warn";

  const submit = async () => {
    if (countedN == null || !Number.isFinite(countedN) || countedN < 0) {
      onError(t.countRequired);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/cash-shifts/${shiftId}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          countedCash: countedN,
          closingNote: note.trim() || null,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        onError(json.error || t.errorGeneric);
        return;
      }
      setCounted("");
      setNote("");
      await onClosed();
      onClose();
      router.push(`/cash-shifts/${shiftId}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t.title}>
      <div className="space-y-4">
        <div className="rounded-xl bg-bg-main/50 p-4 text-center">
          <p className="text-xs text-text-secondary">{t.expectedLabel}</p>
          <p className="text-2xl font-bold text-text-primary mt-1" dir="ltr">
            ₤{fmt(expectedCash)}
          </p>
        </div>

        <Input
          label={t.countedLabel}
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={counted}
          onChange={(e) => setCounted(e.target.value)}
          autoFocus
        />

        {variance != null && (
          <div
            className={`rounded-lg p-3 text-sm font-medium text-center ${
              tone === "good"
                ? "bg-success-light text-success"
                : tone === "bad"
                  ? "bg-danger-light text-danger"
                  : "bg-orange-100 text-orange-700"
            }`}
          >
            {tone === "good"
              ? `✅ ${t.balanced}`
              : tone === "bad"
                ? `⚠ ${t.short.replace("{amount}", `${fmt(Math.abs(variance))} ₤`)}`
                : `⚠ ${t.over.replace("{amount}", `${fmt(variance)} ₤`)}`}
          </div>
        )}

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
            {t.submit}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
