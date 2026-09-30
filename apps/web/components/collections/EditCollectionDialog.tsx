"use client";

import { useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { useCollectionDecision } from "@/hooks/useCollections";
import { useCollectionAccounts } from "@/hooks/useCollectionAccounts";
import { AccountPicker } from "./AccountPicker";
import { errorCode, errorCopy } from "./copy";
import { EMPTY_TRANSFER, accountsForMethod, validateTransfer } from "./rules";
import type { DecisionDialogProps } from "./ConfirmDialog";

const inputCls =
  "w-full min-h-11 px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent";

/**
 * Fix the account or add the payer hints while a transfer is pending
 * (doc 15 spec 12 §4.7): the recorder or a confirmer. Sends only what
 * changed; an emptied payer field is cleared (null).
 */
export function EditCollectionDialog(props: DecisionDialogProps) {
  return props.open ? <EditCollectionDialogBody {...props} /> : null;
}

function EditCollectionDialogBody({ collection, open, onClose, onDone, onStale }: DecisionDialogProps) {
  const dict = useDictionary();
  const t = dict.app.collections.detail as Record<string, unknown> & typeof dict.app.collections.detail;
  const pos = dict.app.collections.pos as Record<string, string>;
  const { edit } = useCollectionDecision();
  const { accounts, branchId } = useCollectionAccounts({ enabled: open });
  const listed = useMemo(
    () => accountsForMethod(accounts, collection.method, branchId ?? collection.branchId),
    [accounts, collection.method, collection.branchId, branchId],
  );
  const [accountId, setAccountId] = useState<string | null>(collection.account?.id ?? null);
  const [last4, setLast4] = useState(collection.payerPhoneLast4 ?? "");
  const [ref, setRef] = useState(collection.payerReference ?? "");
  const [error, setError] = useState<string | null>(null);

  const check = validateTransfer({
    method: collection.method,
    draft: { ...EMPTY_TRANSFER, accountId, payerPhoneLast4: last4, payerReference: ref, parts: [] },
    total: 0,
    listed,
    accountsKnown: true,
    requireAccount: false,
  });

  const body: { collectionAccountId?: string; payerPhoneLast4?: string | null; payerReference?: string | null } = {};
  if (accountId && accountId !== (collection.account?.id ?? null)) body.collectionAccountId = accountId;
  if (last4.trim() !== (collection.payerPhoneLast4 ?? "")) body.payerPhoneLast4 = last4.trim() || null;
  if (ref.trim() !== (collection.payerReference ?? "")) body.payerReference = ref.trim() || null;
  const dirty = Object.keys(body).length > 0;

  const submit = async () => {
    setError(null);
    try {
      await edit.mutateAsync({ id: collection.id, body });
      onDone("saved");
    } catch (e) {
      const code = errorCode(e);
      if (code === "COLLECTION_NOT_PENDING") onStale?.();
      setError(errorCopy(code, [dict.app.collections.errors as Record<string, string>], t.actionFailed));
    }
  };

  const title = (t.editSheet as { title?: string } | undefined)?.title ?? t.edit;
  return (
    <Modal isOpen={open} onClose={onClose} title={title}>
      <div className="space-y-3">
        {listed.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-text-primary">{pos.pickAccount}</p>
            <AccountPicker
              name="collection-edit-account"
              ariaLabel={pos.pickAccount}
              accounts={listed}
              value={accountId}
              onChange={setAccountId}
              testIdPrefix="collection-edit-account-"
            />
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="block">
            <span className="block text-[11px] text-text-secondary mb-0.5">{pos.payerLast4Label}</span>
            <input
              inputMode="numeric"
              maxLength={4}
              dir="ltr"
              autoComplete="off"
              value={last4}
              onChange={(e) => setLast4(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="block text-[11px] text-text-secondary mb-0.5">{pos.referenceLabel}</span>
            <input
              maxLength={16}
              dir="ltr"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              className={inputCls}
            />
          </label>
        </div>
        {check.errors.map((e) => (
          <p key={e.code} role="alert" className="text-[11px] text-danger">
            {e.code === "payer_last4_invalid" ? pos.payerLast4Invalid : pos.referenceInvalid}
          </p>
        ))}
        {error && (
          <p role="alert" className="text-xs text-danger bg-danger-light px-3 py-2 rounded-lg">
            {error}
          </p>
        )}
        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="ghost" onClick={onClose} disabled={edit.isPending}>
            {dict.app.collectionsSettings.form.cancel}
          </Button>
          <Button
            className="min-h-11"
            data-testid="collection-edit-save"
            onClick={submit}
            loading={edit.isPending}
            disabled={!dirty || check.errors.length > 0}
          >
            {t.save}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
