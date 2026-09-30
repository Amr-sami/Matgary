"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";
import { newIdempotencyKey, type CollectionDTO } from "@/lib/api/collections";
import { useCollectionDecision } from "@/hooks/useCollections";
import { errorCode, errorCopy } from "./copy";

export interface DecisionDialogProps {
  collection: CollectionDTO;
  open: boolean;
  onClose: () => void;
  /** After a success: the toast key under `app.collections.detail.done`. */
  onDone: (done: "confirmed" | "rejected" | "reopened" | "saved") => void;
  /** 409 COLLECTION_NOT_PENDING etc.: the parent refetches the detail. */
  onStale?: () => void;
}

/**
 * "Check your bank or wallet app first" (doc 15 spec 12 §4.7). Import it as
 * `CollectionConfirmDialog` where components/ui/ConfirmDialog is also used.
 * One Idempotency-Key per opening, reused on every retry inside it, so a
 * double click or a lost response never decides twice (03 §C.8 rule 12).
 */
export function ConfirmDialog(props: DecisionDialogProps) {
  // Mounted per opening: the key and the error reset with it.
  return props.open ? <ConfirmDialogBody {...props} /> : null;
}

function ConfirmDialogBody({ collection, open, onClose, onDone, onStale }: DecisionDialogProps) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.collections.detail;
  const { confirm } = useCollectionDecision();
  const [key] = useState(newIdempotencyKey);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await confirm.mutateAsync({ id: collection.id, key });
      onDone("confirmed");
    } catch (e) {
      const code = errorCode(e);
      if (code === "COLLECTION_NOT_PENDING") onStale?.();
      setError(errorCopy(code, [dict.app.collections.errors as Record<string, string>], t.actionFailed));
    }
  };

  const account = collection.account ? collection.account.label : dict.app.collections.inbox.row.noAccount;
  return (
    <Modal isOpen={open} onClose={onClose} title={t.confirmSheet.title}>
      <div className="space-y-3">
        <p className="text-sm text-text-primary">
          {t.confirmSheet.check
            .replace("{account}", account)
            .replace("{amount}", formatCurrency(collection.amount, locale))}
        </p>
        <p className="text-xs font-medium text-danger">{t.confirmSheet.noScreenshot}</p>
        {error && (
          <p role="alert" className="text-xs text-danger bg-danger-light px-3 py-2 rounded-lg">
            {error}
          </p>
        )}
        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="ghost" onClick={onClose} disabled={confirm.isPending}>
            {dict.app.collectionsSettings.form.cancel}
          </Button>
          <Button className="min-h-11" data-testid="collection-confirm-submit" onClick={submit} loading={confirm.isPending} disabled={!key}>
            {t.confirmSheet.submit}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
