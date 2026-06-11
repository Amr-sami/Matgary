"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface Props {
  isOpen: boolean;
  tenantName: string;
  tenantId: string;
  onClose: () => void;
  onSuccess: () => void | Promise<void>;
  onError: (msg: string) => void;
}

export function SuspendTenantModal({
  isOpen,
  tenantName,
  tenantId,
  onClose,
  onSuccess,
  onError,
}: Props) {
  const dict = useDictionary();
  const t = dict.app.admin.tenants.detail.actions.suspendModal;
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < 5 || trimmed.length > 500) {
      onError(t.reasonLabel);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}/suspend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: trimmed }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        onError(j.error || t.errorGeneric);
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
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            {t.reasonLabel}
          </label>
          <textarea
            rows={3}
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
          <Button variant="danger" onClick={submit} loading={submitting}>
            {t.confirm}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
