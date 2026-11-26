"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatDateTime } from "@/lib/i18n/format";
import { newIdempotencyKey } from "@/lib/api/collections";
import { useCollectionDecision } from "@/hooks/useCollections";
import { errorCode, errorCopy } from "./copy";
import { reopenUntil } from "./rules";
import type { DecisionDialogProps } from "./ConfirmDialog";

/** Owner only, ≤ 7 days after the decision: back to pending, and any debt
 *  the rejection created is undone (doc 15 spec 12 §4.7). */
export function ReopenDialog(props: DecisionDialogProps) {
  return props.open ? <ReopenDialogBody {...props} /> : null;
}

function ReopenDialogBody({ collection, open, onClose, onDone, onStale }: DecisionDialogProps) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.collections.detail;
  const { reopen } = useCollectionDecision();
  const [key] = useState(newIdempotencyKey);
  const [error, setError] = useState<string | null>(null);

  const until = reopenUntil(collection);
  const submit = async () => {
    setError(null);
    try {
      await reopen.mutateAsync({ id: collection.id, key });
      onDone("reopened");
    } catch (e) {
      const code = errorCode(e);
      if (code === "COLLECTION_NOT_REOPENABLE" || code === "REOPEN_WINDOW_CLOSED") onStale?.();
      setError(errorCopy(code, [dict.app.collections.errors as Record<string, string>], t.actionFailed));
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} title={t.reopenSheet.title}>
      <div className="space-y-3">
        <p className="text-sm text-text-primary">{t.reopenSheet.body}</p>
        {until && (
          <p className="text-xs text-text-secondary">
            {t.reopenUntil.replace("{date}", formatDateTime(until, locale))}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger bg-danger-light px-3 py-2 rounded-lg">
            {error}
          </p>
        )}
        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="ghost" onClick={onClose} disabled={reopen.isPending}>
            {dict.app.collectionsSettings.form.cancel}
          </Button>
          <Button className="min-h-11" data-testid="collection-reopen-submit" onClick={submit} loading={reopen.isPending} disabled={!key}>
            {t.reopenSheet.submit}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
