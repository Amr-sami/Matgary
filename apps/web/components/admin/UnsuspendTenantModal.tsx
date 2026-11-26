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

export function UnsuspendTenantModal({
  isOpen,
  tenantName,
  tenantId,
  onClose,
  onSuccess,
  onError,
}: Props) {
  const dict = useDictionary();
  const t = dict.app.admin.tenants.detail.actions.unsuspendModal;
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}/unsuspend`, {
        method: "POST",
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
