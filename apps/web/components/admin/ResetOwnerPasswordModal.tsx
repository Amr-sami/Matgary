"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

/**
 * Two-step owner password-reset modal.
 *
 * Step 1 — "confirm":  Admin reads what will happen, clicks Reset. We fire
 *                       POST /reset-owner-password.
 * Step 2 — "result":   The server-generated temporary password is shown
 *                       ONCE. The admin copies it, then Close. The modal
 *                       does not keep it in any state after close.
 *
 * We never show the password in step 1 and never GET it back from the API
 * afterwards. Closing the modal in step 2 is the admin's acknowledgement.
 */
interface Props {
  isOpen: boolean;
  tenantName: string;
  tenantId: string;
  ownerEmail: string | null;
  onClose: () => void;
  onError: (msg: string) => void;
}

type Phase = "confirm" | "result";

export function ResetOwnerPasswordModal({
  isOpen,
  tenantName,
  tenantId,
  ownerEmail,
  onClose,
  onError,
}: Props) {
  const dict = useDictionary();
  const t = dict.app.admin.tenants.detail.actions.resetPasswordModal;

  const [phase, setPhase] = useState<Phase>("confirm");
  const [submitting, setSubmitting] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const close = () => {
    // Blank the password before the parent hides us — prevents a flash of
    // the last reset if the modal is re-opened for another tenant.
    setTempPassword(null);
    setCopied(false);
    setPhase("confirm");
    onClose();
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/admin/tenants/${tenantId}/reset-owner-password`,
        { method: "POST" },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        onError(j.error || t.errorGeneric);
        return;
      }
      const data = (await res.json()) as { temporaryPassword: string };
      setTempPassword(data.temporaryPassword);
      setPhase("result");
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async () => {
    if (!tempPassword) return;
    try {
      await navigator.clipboard.writeText(tempPassword);
      setCopied(true);
      // No timed clear — the user told us they copied; leave the badge.
    } catch {
      // Clipboard denied; the input remains selectable manually.
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title={t.title}>
      {phase === "confirm" ? (
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">{t.intro}</p>
          <div className="bg-bg-main/40 rounded-lg p-3 text-xs space-y-1">
            <p>
              <span className="text-text-secondary">{t.storeLabel}: </span>
              <span className="font-medium" dir="auto">
                {tenantName}
              </span>
            </p>
            <p>
              <span className="text-text-secondary">{t.ownerLabel}: </span>
              <span className="font-medium" dir="ltr">
                {ownerEmail ?? "—"}
              </span>
            </p>
          </div>
          <ul className="text-xs text-text-secondary list-disc ps-5 space-y-1">
            <li>{t.bullets.newPassword}</li>
            <li>{t.bullets.signOutEverywhere}</li>
            <li>{t.bullets.forceRotation}</li>
            <li>{t.bullets.audited}</li>
          </ul>
          <div className="flex gap-2 justify-end pt-2 border-t border-border">
            <Button variant="secondary" onClick={close} disabled={submitting}>
              {t.cancel}
            </Button>
            <Button onClick={submit} loading={submitting} variant="danger">
              {t.confirm}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm font-medium">{t.resultIntro}</p>
          <p className="text-xs text-text-secondary">{t.resultWarning}</p>
          <div className="bg-bg-main rounded-lg p-3 border border-border">
            <p className="text-[11px] text-text-secondary mb-1">
              {t.tempPasswordLabel}
            </p>
            <code
              className="block font-mono text-lg break-all select-all"
              dir="ltr"
            >
              {tempPassword}
            </code>
          </div>
          <div className="flex gap-2 justify-end pt-2 border-t border-border">
            <Button variant="secondary" onClick={copy}>
              {copied ? t.copied : t.copy}
            </Button>
            <Button onClick={close}>{t.close}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
