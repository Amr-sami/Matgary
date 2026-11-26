"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { newIdempotencyKey } from "@/lib/api/collections";
import { useCreditActions } from "@/hooks/useCollections";
import { useCollectionAccounts } from "@/hooks/useCollectionAccounts";
import { errorCode, errorCopy } from "./copy";
import { pasteNotice } from "./rules";

/** 07 §4.5: `text` 1..10,000 characters. */
export const PASTE_MAX_CHARS = 10_000;

/**
 * "Paste a message" (doc 15 spec 12 §4.7, M2): the bank or wallet message as
 * it is (several are fine), an optional receiving account, and
 * `credits-paste-submit` → `POST /api/collections/credits/paste`. Pasted
 * credits are always held `manual_source` (they never auto-confirm). One
 * Idempotency-Key per opening, reused on every retry. Reuses 08's
 * `app.collections.credits.pasteSheet.*` (no `web.` leaf).
 */
export function PasteDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (message: string) => void }) {
  return open ? <PasteDialogBody onClose={onClose} onDone={onDone} /> : null;
}

function PasteDialogBody({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const dict = useDictionary();
  const t = dict.app.collections.credits.pasteSheet;
  const providers = dict.app.collections.vocab.providers as Record<string, string>;
  const { paste } = useCreditActions();
  const accountsQ = useCollectionAccounts({ scope: "branch" });
  const accounts = accountsQ.accounts.filter((a) => a.archivedAt == null);
  const [key] = useState(newIdempotencyKey);
  const [text, setText] = useState("");
  const [accountId, setAccountId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const trimmed = text.trim();
  const submit = async () => {
    if (!trimmed) return;
    setError(null);
    try {
      const res = await paste.mutateAsync({ text, accountId: accountId || undefined, key });
      onDone(pasteNotice(res.results, dict.app.collections.credits.done));
    } catch (e) {
      setError(
        errorCopy(errorCode(e), [dict.app.collections.errors as Record<string, string>], dict.app.collections.detail.actionFailed),
      );
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={t.title}>
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">{t.hint}</p>
        <textarea
          data-testid="credits-paste-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={PASTE_MAX_CHARS}
          rows={7}
          dir="auto"
          aria-label={t.title}
          className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
        {accounts.length > 0 && (
          <label className="block space-y-1">
            <span className="text-xs text-text-secondary">{t.account}</span>
            <select
              data-testid="credits-paste-account"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="w-full min-h-11 px-3 rounded-lg border border-border bg-white text-sm"
            >
              <option value="">—</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id} data-testid={`credits-paste-account-${a.id}`}>
                  {a.label} · {providers[a.provider] ?? a.provider}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger bg-danger-light px-3 py-2 rounded-lg">
            {error}
          </p>
        )}
        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="ghost" onClick={onClose} disabled={paste.isPending}>
            {dict.app.collectionsSettings.form.cancel}
          </Button>
          <Button
            className="min-h-11"
            data-testid="credits-paste-submit"
            onClick={submit}
            loading={paste.isPending}
            disabled={!trimmed}
          >
            {t.submit}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
