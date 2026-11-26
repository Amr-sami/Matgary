"use client";

import { useState, type ReactNode } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { COLLECTION_PROVIDERS } from "@matgary/domain/collections/providers";
import type { CollectionProvider, CollectionRail } from "@matgary/domain/collections/types";
import type { AccountCreateBody } from "@matgary/api-client/endpoints/collections";
import { newIdempotencyKey, type CollectionAccount } from "@/lib/api/collections";
import { useCollectionAccountMutations } from "@/hooks/useCollectionAccounts";
import { cn } from "@/lib/utils";
import { errorCode, errorCopy } from "./copy";
import {
  accountPatchBody,
  draftFromDto,
  emptyAccountDraft,
  ipaFromDraft,
  localYmd,
  validateAccountDraft,
  type AccountColumn,
  type AccountDraft,
  type AccountFormError,
} from "./rules";

const inputCls =
  "w-full min-h-11 px-3 py-2 rounded-lg border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent";

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-text-secondary mb-1">{label}</span>
      {children}
      {hint && !error && <span className="block text-[11px] text-text-secondary mt-0.5">{hint}</span>}
      {error && (
        <span role="alert" className="block text-[11px] text-danger mt-0.5">
          {error}
        </span>
      )}
    </label>
  );
}

function Check({
  testId,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  testId: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-3 min-h-11 py-2 cursor-pointer">
      <input
        type="checkbox"
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-5 h-5 accent-accent shrink-0"
      />
      <span className="min-w-0">
        <span className="block text-sm text-text-primary">{label}</span>
        {hint && <span className="block text-[11px] text-text-secondary">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * Create / edit / archive a receiving account (doc 15 spec 12 §4.8, the
 * fields and rules of 09 §4.4). Each input is
 * `data-testid="collection-account-form-<column>"` (03 §B.2.1 names). Create
 * sends an Idempotency-Key minted when the form opens; edit PATCHes the
 * changed fields only. The full IBAN appears only in this form.
 */
export function AccountFormModal({
  open,
  rail,
  account,
  branches,
  defaultBranchId,
  isOwner,
  ingestOn,
  branchAutoConfirmOn,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Create: the rail picked from the add menu. Edit: the account's rail. */
  rail: CollectionRail;
  /** null = create. */
  account: CollectionAccount | null;
  branches: Array<{ id: string; name: string }>;
  defaultBranchId: string | null;
  isOwner: boolean;
  ingestOn: boolean;
  branchAutoConfirmOn: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const dict = useDictionary();
  const f = dict.app.collectionsSettings.form;
  const fields = f.fields;
  const providersT = dict.app.collections.vocab.providers as Record<string, string>;
  const { create, update, archive } = useCollectionAccountMutations();
  const today = localYmd(new Date());

  // The page mounts this form per opening (keyed by account / rail), so the
  // draft, errors and the create Idempotency-Key all start fresh here.
  const [initial] = useState<AccountDraft>(() =>
    account ? draftFromDto(account) : emptyAccountDraft(rail, defaultBranchId),
  );
  const [draft, setDraft] = useState<AccountDraft>(initial);
  const [errors, setErrors] = useState<Partial<Record<AccountColumn, AccountFormError>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [key] = useState(newIdempotencyKey);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const set = <K extends keyof AccountDraft>(k: K, v: AccountDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const providerOptions = (Object.values(COLLECTION_PROVIDERS) as Array<{ id: CollectionProvider; rail: CollectionRail }>).filter(
    (p) => p.rail === draft.rail,
  );
  const ipa = ipaFromDraft(draft);
  const errText = (c: AccountColumn) => {
    const e = errors[c];
    if (!e) return null;
    const path = e.split(".");
    let node: unknown = f;
    for (const p of path) node = (node as Record<string, unknown> | undefined)?.[p];
    return typeof node === "string" ? node : e;
  };
  const busy = create.isPending || update.isPending || archive.isPending;

  const submit = async () => {
    setServerError(null);
    const opts = { includeL2: ingestOn, today };
    try {
      if (!account) {
        const r = validateAccountDraft(draft, opts);
        if (!r.ok) {
          setErrors(r.errors);
          return;
        }
        setErrors({});
        await create.mutateAsync({ body: r.body as unknown as AccountCreateBody, key });
        onSaved(f.created);
      } else {
        const r = accountPatchBody(initial, draft, ingestOn, today);
        if (!r.ok) {
          setErrors(r.errors);
          return;
        }
        setErrors({});
        if (Object.keys(r.body).length === 0) {
          onClose();
          return;
        }
        await update.mutateAsync({ id: account.id, patch: r.body });
        onSaved(f.saved);
      }
    } catch (e) {
      const code = errorCode(e);
      const status = (e as { status?: number }).status;
      setServerError(
        errorCopy(code, [dict.app.collections.errors as Record<string, string>], status === 409 ? f.duplicate : f.saveFailed),
      );
    }
  };

  const doArchive = async () => {
    if (!account) return;
    try {
      await archive.mutateAsync(account.id);
      onSaved(f.archived);
    } catch (e) {
      setServerError(errorCopy(errorCode(e), [dict.app.collections.errors as Record<string, string>], f.saveFailed));
    }
  };

  const title = account ? f.editTitle : draft.rail === "instapay" ? f.newTitleInstapay : f.newTitleWallet;
  const border = (c: AccountColumn) => (errors[c] ? "border-danger" : "border-border");

  return (
    <>
      <Modal isOpen={open} onClose={onClose} title={title}>
        <div className="space-y-3">
          <Field
            label={draft.rail === "instapay" ? fields.provider.bank : fields.provider.wallet}
            error={errText("provider")}
          >
            <select
              data-testid="collection-account-form-provider"
              value={draft.provider}
              disabled={!!account}
              onChange={(e) => set("provider", e.target.value as CollectionProvider)}
              className={cn(inputCls, border("provider"))}
            >
              <option value="">{fields.provider.pickTitle}</option>
              {providerOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {providersT[p.id] ?? p.id}
                </option>
              ))}
            </select>
          </Field>

          <Field label={fields.label.label} error={errText("label")}>
            <input
              data-testid="collection-account-form-label"
              value={draft.label}
              maxLength={80}
              placeholder={fields.label.placeholder}
              onChange={(e) => set("label", e.target.value)}
              className={cn(inputCls, border("label"))}
              dir="auto"
            />
          </Field>

          <Field label={fields.holderName.label} hint={fields.holderName.hint} error={errText("holder_name")}>
            <input
              data-testid="collection-account-form-holder_name"
              value={draft.holderName}
              onChange={(e) => set("holderName", e.target.value)}
              className={cn(inputCls, border("holder_name"))}
              dir="auto"
            />
          </Field>

          {draft.rail === "instapay" ? (
            <>
              <Field label={fields.ipaLink.label} hint={fields.ipaLink.hint} error={errText("ipa_link")}>
                <textarea
                  data-testid="collection-account-form-ipa_link"
                  value={draft.ipaText}
                  rows={2}
                  dir="ltr"
                  spellCheck={false}
                  onChange={(e) => set("ipaText", e.target.value)}
                  className={cn(inputCls, border("ipa_link"))}
                />
              </Field>
              {ipa.handle && !ipa.invalid && (
                <p className="text-[11px] text-success -mt-2" dir="auto">
                  {fields.ipaLink.derived.replace("{handle}", ipa.handle)}
                </p>
              )}
              {!ipa.invalid && ipa.link == null && draft.ipaText.trim() === "" && (
                <p className="text-[11px] text-orange-700 -mt-2">{fields.ipaLink.missingWarning}</p>
              )}
              <Field label={fields.accountLast4.label} hint={fields.accountLast4.hint} error={errText("account_last4")}>
                <input
                  data-testid="collection-account-form-account_last4"
                  inputMode="numeric"
                  maxLength={4}
                  dir="ltr"
                  value={draft.accountLast4}
                  onChange={(e) => set("accountLast4", e.target.value)}
                  className={cn(inputCls, border("account_last4"))}
                />
              </Field>
              {draft.provider === "nbe" && (
                <Check
                  testId="collection-account-form-is_prepaid_card"
                  label={fields.isPrepaidCard.label}
                  hint={fields.isPrepaidCard.hint}
                  checked={draft.isPrepaidCard}
                  onChange={(v) => set("isPrepaidCard", v)}
                />
              )}
              <Field label={fields.iban.label} error={errText("iban")}>
                <input
                  data-testid="collection-account-form-iban"
                  dir="ltr"
                  autoCapitalize="characters"
                  spellCheck={false}
                  value={draft.iban}
                  onChange={(e) => set("iban", e.target.value)}
                  className={cn(inputCls, border("iban"))}
                />
              </Field>
              {errors.identity && (
                <p role="alert" className="text-[11px] text-danger">
                  {f.identityRequired}
                </p>
              )}
            </>
          ) : (
            <>
              <Field label={fields.walletMsisdn.label} error={errText("wallet_msisdn")}>
                <input
                  data-testid="collection-account-form-wallet_msisdn"
                  inputMode="tel"
                  dir="ltr"
                  value={draft.walletMsisdn}
                  onChange={(e) => set("walletMsisdn", e.target.value)}
                  className={cn(inputCls, border("wallet_msisdn"))}
                />
              </Field>
              <Field label={fields.walletOpenedOn.label} hint={fields.walletOpenedOn.hint}>
                <input
                  type="date"
                  data-testid="collection-account-form-wallet_opened_on"
                  max={today}
                  dir="ltr"
                  value={draft.walletOpenedOn}
                  onChange={(e) => set("walletOpenedOn", e.target.value)}
                  className={cn(inputCls, "border-border")}
                />
              </Field>
            </>
          )}

          <Field label={fields.branch.label}>
            <select
              data-testid="collection-account-form-branch_id"
              value={draft.branchId ?? ""}
              disabled={!isOwner}
              onChange={(e) => set("branchId", e.target.value === "" ? null : e.target.value)}
              className={cn(inputCls, "border-border")}
            >
              {isOwner && <option value="">{fields.branch.all}</option>}
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>

          <Check
            testId="collection-account-form-is_pos_default"
            label={fields.isPosDefault.label}
            hint={fields.isPosDefault.hint}
            checked={draft.isPosDefault}
            onChange={(v) => set("isPosDefault", v)}
          />
          {draft.rail === "instapay" && (
            <Check
              testId="collection-account-form-is_default_for_mobile"
              label={fields.isDefaultForMobile.label}
              hint={fields.isDefaultForMobile.hint}
              checked={draft.isDefaultForMobile}
              onChange={(v) => set("isDefaultForMobile", v)}
            />
          )}

          {ingestOn && (
            <div className="rounded-xl border border-border p-3 space-y-2">
              <p className="text-xs font-semibold text-text-primary">{f.l2Heading}</p>
              <Check
                testId="collection-account-form-auto_confirm_enabled"
                label={fields.autoConfirmEnabled.label}
                hint={branchAutoConfirmOn ? fields.autoConfirmEnabled.hint : fields.autoConfirmEnabled.branchOff}
                checked={draft.autoConfirmEnabled}
                onChange={(v) => (v ? setConfirmAuto(true) : set("autoConfirmEnabled", false))}
              />
              <Field label={fields.reviewThreshold.label} hint={fields.reviewThreshold.hint} error={errText("review_threshold")}>
                <input
                  data-testid="collection-account-form-review_threshold"
                  inputMode="decimal"
                  dir="ltr"
                  value={draft.reviewThreshold}
                  onChange={(e) => set("reviewThreshold", e.target.value)}
                  className={cn(inputCls, border("review_threshold"))}
                />
              </Field>
              {draft.rail === "wallet" && (
                <Check
                  testId="collection-account-form-balance_check_enabled"
                  label={fields.balanceCheckEnabled.label}
                  hint={fields.balanceCheckEnabled.hint}
                  checked={draft.balanceCheckEnabled}
                  onChange={(v) => set("balanceCheckEnabled", v)}
                />
              )}
            </div>
          )}

          {serverError && (
            <p role="alert" className="text-xs text-danger bg-danger-light px-3 py-2 rounded-lg">
              {serverError}
            </p>
          )}

          <div className="flex flex-wrap gap-2 justify-between pt-2 border-t border-border">
            {account ? (
              <Button
                variant="ghost"
                data-testid="collection-account-archive"
                className="text-danger"
                disabled={busy}
                onClick={() => setConfirmArchive(true)}
              >
                {f.archive}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="secondary" className="min-h-11" onClick={onClose} disabled={busy}>
                {f.cancel}
              </Button>
              <Button className="min-h-11" data-testid="collection-account-save" onClick={submit} loading={create.isPending || update.isPending}>
                {account ? f.save : f.create}
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={confirmAuto}
        onClose={() => setConfirmAuto(false)}
        onConfirm={() => set("autoConfirmEnabled", true)}
        title={fields.autoConfirmEnabled.confirmTitle}
        message={fields.autoConfirmEnabled.confirmBody.replace(
          "{amount}",
          draft.reviewThreshold.trim() || String(account?.reviewThreshold ?? 5000),
        )}
        variant="primary"
      />
      <ConfirmDialog
        isOpen={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        onConfirm={doArchive}
        title={f.archiveConfirmTitle.replace("{label}", account?.label ?? "")}
        message={f.archiveConfirmBody}
        confirmText={f.archive}
      />
    </>
  );
}
