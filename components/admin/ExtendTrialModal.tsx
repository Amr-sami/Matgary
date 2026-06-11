"use client";

import { useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

interface Props {
  isOpen: boolean;
  tenantName: string;
  tenantId: string;
  currentTrialEndsAt: string;
  onClose: () => void;
  onSuccess: () => void | Promise<void>;
  onError: (msg: string) => void;
}

export function ExtendTrialModal({
  isOpen,
  tenantName,
  tenantId,
  currentTrialEndsAt,
  onClose,
  onSuccess,
  onError,
}: Props) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.admin.tenants.detail.actions.extendModal;
  const dateLocale = locale === "ar" ? "ar-EG" : "en-US";

  const [days, setDays] = useState<string>("14");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const previewDate = useMemo(() => {
    const n = Number(days);
    if (!Number.isFinite(n) || n < 1 || n > 90) return null;
    return new Date(
      new Date(currentTrialEndsAt).getTime() + n * 24 * 60 * 60 * 1000,
    );
  }, [days, currentTrialEndsAt]);

  const submit = async () => {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 90) {
      onError(t.daysLabel);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}/extend-trial`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: n, reason: reason.trim() || null }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        if (j.error === "NOT_TRIALING") {
          onError(t.errorNotTrialing);
        } else {
          onError(j.error || t.errorGeneric);
        }
        return;
      }
      setReason("");
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
        <div className="bg-bg-main/40 rounded-lg p-3 text-xs space-y-1">
          <p>
            <span className="text-text-secondary">{t.currentLabel}: </span>
            <span className="font-medium" dir="ltr">
              {new Date(currentTrialEndsAt).toLocaleDateString(dateLocale)}
            </span>
          </p>
          {previewDate && (
            <p>
              <span className="text-text-secondary">{t.previewLabel}: </span>
              <span className="font-medium text-accent" dir="ltr">
                {previewDate.toLocaleDateString(dateLocale)}
              </span>
            </p>
          )}
        </div>
        <Input
          label={t.daysLabel}
          type="number"
          min={1}
          max={90}
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            {t.reasonLabel}
          </label>
          <textarea
            rows={2}
            dir="auto"
            placeholder={t.reasonPlaceholder}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
          />
        </div>
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
