"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface Props {
  isOpen: boolean;
  tenantId: string;
  tenantName: string;
  onClose: () => void;
  onError: (msg: string) => void;
}

/** Friction-by-design: the admin has to type the tenant name exactly before
 *  the Impersonate button enables. Sets a deliberate cognitive checkpoint
 *  before crossing into the tenant's data. */
export function ImpersonationConfirmModal({
  isOpen,
  tenantId,
  tenantName,
  onClose,
  onError,
}: Props) {
  const dict = useDictionary();
  const t = dict.app.admin.tenants.detail.actions.impersonateModal;
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}/impersonate`, {
        method: "POST",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        onError(mapError(j.error, t.errors));
        return;
      }
      const json = (await res.json()) as { redirectTo: string };
      // Hard navigation so the cookie set by /api/admin/impersonation/start
      // is picked up before any tenant page renders.
      window.location.assign(json.redirectTo);
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = confirm.trim() === tenantName.trim() && !submitting;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t.title}>
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">{t.intro}</p>
        <p
          className="text-xs text-text-secondary bg-bg-main/60 rounded-md p-2"
          dir="auto"
        >
          {tenantName}
        </p>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            {t.confirmLabel}
          </label>
          <input
            type="text"
            dir="auto"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t.cancel}
          </Button>
          <Button variant="danger" onClick={submit} disabled={!canSubmit} loading={submitting}>
            {t.submit}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface ErrorT {
  TENANT_SUSPENDED: string;
  OWNER_DISABLED: string;
  NO_OWNER: string;
  REDIS_UNAVAILABLE: string;
  generic: string;
}

function mapError(code: string | undefined, t: ErrorT): string {
  switch (code) {
    case "TENANT_SUSPENDED":
      return t.TENANT_SUSPENDED;
    case "OWNER_DISABLED":
      return t.OWNER_DISABLED;
    case "NO_OWNER":
      return t.NO_OWNER;
    case "REDIS_UNAVAILABLE":
      return t.REDIS_UNAVAILABLE;
    default:
      return t.generic;
  }
}
