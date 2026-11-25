"use client";

import { useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

/**
 * Enable-trial modal. Distinct from the extend modal: this one STARTS a
 * fresh N-day trial from now, regardless of previous subscription state.
 * Useful for stores whose trial has expired or been cancelled.
 */
interface Props {
  isOpen: boolean;
  tenantName: string;
  tenantId: string;
  onClose: () => void;
  onSuccess: () => void | Promise<void>;
  onError: (msg: string) => void;
}

const PRESETS = [7, 14, 30] as const;

export function EnableTrialModal({
  isOpen,
  tenantName,
  tenantId,
  onClose,
  onSuccess,
  onError,
}: Props) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.admin.tenants.detail.actions.enableTrialModal;
  const dateLocale = locale === "ar" ? "ar-EG" : "en-US";

  const [days, setDays] = useState<string>("14");
  const [submitting, setSubmitting] = useState(false);

  const previewDate = useMemo(() => {
    const n = Number(days);
    if (!Number.isFinite(n) || n < 1 || n > 90) return null;
    return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  }, [days]);

  const submit = async () => {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 90) {
      onError(t.errorInvalidDays);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}/enable-trial`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: n }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        onError(j.error || t.errorGeneric);
        return;
      }
      await onSuccess();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t.title}>
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">{t.intro}</p>
        <p className="text-xs text-text-secondary" dir="auto">
          {tenantName}
        </p>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(String(d))}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                Number(days) === d
                  ? "bg-accent text-white"
                  : "bg-white border border-border text-text-secondary hover:border-accent"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
        <Input
          label={t.daysLabel}
          type="number"
          min={1}
          max={90}
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
        {previewDate && (
          <div className="bg-bg-main/40 rounded-lg p-3 text-xs">
            <span className="text-text-secondary">{t.previewLabel}: </span>
            <span className="font-medium text-accent" dir="ltr">
              {previewDate.toLocaleDateString(dateLocale)}
            </span>
          </div>
        )}
        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t.cancel}
          </Button>
          <Button onClick={submit} loading={submitting}>
            {t.confirm}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
