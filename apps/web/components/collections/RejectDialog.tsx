"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { normalizeEgyptPhone } from "@/lib/validators/egypt";
import { newIdempotencyKey } from "@/lib/api/collections";
import { useCollectionDecision } from "@/hooks/useCollections";
import type { RejectOutcome, RejectReason } from "@matgary/api-client/endpoints/collections";
import { cn } from "@/lib/utils";
import { errorCode, errorCopy } from "./copy";
import { defaultRejectOutcome } from "./rules";
import type { DecisionDialogProps } from "./ConfirmDialog";

const REASONS: RejectReason[] = ["not_received", "wrong_amount", "wrong_account", "duplicate", "other"];
const NOTE_MAX = 280;

/**
 * "Transfer not received" (doc 15 spec 12 §4.7, Q4): a reason (required, none
 * preselected); the outcome — debt when a phone is known or typed, else a
 * loss flagged on the cashier; settlements are always debt (the payment is
 * voided and the debt restored); an optional note ≤ 280.
 */
export function RejectDialog(props: DecisionDialogProps & { noteMax?: number }) {
  // Mounted per opening: key, reason, outcome, phone and note start fresh.
  return props.open ? <RejectDialogBody {...props} /> : null;
}

function RejectDialogBody({
  collection,
  open,
  onClose,
  onDone,
  onStale,
  noteMax = NOTE_MAX,
}: DecisionDialogProps & { noteMax?: number }) {
  const dict = useDictionary();
  const t = dict.app.collections.detail;
  const rs = t.rejectSheet as Record<string, string>;
  const vocab = dict.app.collections.vocab;
  const { reject } = useCollectionDecision();
  const settlement = collection.sourceType === "settlement";
  const [key] = useState(newIdempotencyKey);
  const [reason, setReason] = useState<RejectReason | null>(null);
  const [outcome, setOutcome] = useState<RejectOutcome>(defaultRejectOutcome(collection));
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const needPhone = !settlement && outcome === "debt" && !collection.customerPhone;
  const normalizedPhone = needPhone ? normalizeEgyptPhone(phone) : null;
  const phoneInvalid = needPhone && phone.trim() !== "" && !normalizedPhone;
  const canSubmit = !!reason && !!key && (!needPhone || !!normalizedPhone) && note.length <= noteMax;

  const submit = async () => {
    if (!reason) return;
    setError(null);
    try {
      await reject.mutateAsync({
        id: collection.id,
        key,
        body: {
          reason,
          outcome: settlement ? "debt" : outcome,
          ...(needPhone && normalizedPhone ? { customerPhone: normalizedPhone } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      });
      onDone("rejected");
    } catch (e) {
      const code = errorCode(e);
      if (code === "COLLECTION_NOT_PENDING") onStale?.();
      setError(errorCopy(code, [dict.app.collections.errors as Record<string, string>], t.actionFailed));
    }
  };

  const recorder = collection.recordedBy?.name;
  const hint = settlement
    ? rs.settlementHint
    : outcome === "debt"
      ? rs.debtHint
      : recorder
        ? rs.lossHint.replace("{name}", recorder)
        : rs.lossHintUnknown ?? rs.lossHint.replace("{name}", "");

  return (
    <Modal isOpen={open} onClose={onClose} title={rs.title}>
      <div className="space-y-4">
        <fieldset>
          <legend className="text-xs font-semibold text-text-primary mb-1.5">{rs.reason}</legend>
          <div className="flex flex-wrap gap-2">
            {REASONS.map((r) => (
              <button
                key={r}
                type="button"
                data-testid={`collection-reject-reason-${r}`}
                aria-pressed={reason === r}
                onClick={() => setReason(r)}
                className={cn(
                  "min-h-11 px-3 rounded-lg border text-xs font-medium transition-colors",
                  reason === r
                    ? "bg-danger text-white border-danger"
                    : "bg-white text-text-secondary border-border hover:border-danger/50",
                )}
              >
                {(vocab.reasons as Record<string, string>)[r] ?? r}
              </button>
            ))}
          </div>
        </fieldset>

        {!settlement && (
          <fieldset>
            <legend className="text-xs font-semibold text-text-primary mb-1.5">{rs.outcome}</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(["debt", "loss"] as RejectOutcome[]).map((o) => (
                <label
                  key={o}
                  data-testid={`collection-reject-outcome-${o}`}
                  className={cn(
                    "flex items-center gap-2 min-h-11 px-3 rounded-lg border cursor-pointer text-xs focus-within:ring-2 focus-within:ring-accent",
                    outcome === o ? "border-accent bg-accent-light/60" : "border-border bg-white",
                  )}
                >
                  <input
                    type="radio"
                    name="collection-reject-outcome"
                    checked={outcome === o}
                    onChange={() => setOutcome(o)}
                    className="w-4 h-4 accent-accent"
                  />
                  {(vocab.outcomes as Record<string, string>)[o] ?? o}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <p className="text-xs text-text-secondary">{hint}</p>

        {needPhone && (
          <label className="block">
            <span className="block text-xs font-medium text-text-secondary mb-1">{rs.phone}</span>
            <input
              data-testid="collection-reject-phone"
              inputMode="tel"
              dir="ltr"
              autoComplete="off"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full min-h-11 px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            {(phone.trim() === "" || phoneInvalid) && (
              <span className={cn("block text-[11px] mt-0.5", phoneInvalid ? "text-danger" : "text-text-secondary")}>
                {phoneInvalid ? dict.app.collections.errors.INVALID_PHONE ?? rs.phoneRequired : rs.phoneRequired}
              </span>
            )}
          </label>
        )}

        <label className="block">
          <span className="block text-xs font-medium text-text-secondary mb-1">{rs.note}</span>
          <textarea
            value={note}
            maxLength={noteMax}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </label>

        {error && (
          <p role="alert" className="text-xs text-danger bg-danger-light px-3 py-2 rounded-lg">
            {error}
          </p>
        )}
        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="ghost" onClick={onClose} disabled={reject.isPending}>
            {dict.app.collectionsSettings.form.cancel}
          </Button>
          <Button
            variant="danger"
            className="min-h-11"
            data-testid="collection-reject-submit"
            onClick={submit}
            loading={reject.isPending}
            disabled={!canSubmit}
          >
            {rs.submit}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
