"use client";

import { useEffect, useMemo } from "react";
import Link from "next/link";
import { isValidIpaLink } from "@matgary/domain/collections/ipa";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";
import { buildWhatsAppLink } from "@/lib/settings";
import { Plus, Trash2, MessageCircle, AlertTriangle } from "@/lib/icons";
import type { AccountsState } from "@/hooks/useCollectionAccounts";
import { AccountPicker } from "./AccountPicker";
import { IpaQr } from "./IpaQr";
import {
  MAX_PARTS,
  addPart,
  cashRemainder,
  defaultAccountFor,
  formatWalletNumber,
  removePart,
  startSplit,
  type AccountLike,
  type DigitalMethod,
  type TransferDraft,
  type TransferErrorCode,
  type TransferIssue,
  type TransferWarningCode,
} from "./rules";

const ERROR_KEY: Record<TransferErrorCode, string> = {
  account_required: "accountRequired",
  part_amount_invalid: "partAmountInvalid",
  parts_exceed_total: "partsExceedTotal",
  too_many_parts: "maxParts",
  payer_last4_invalid: "payerLast4Invalid",
  reference_invalid: "referenceInvalid",
};
const WARNING_KEY: Record<TransferWarningCode, string> = {
  instapay_over_limit: "instapayOverLimit",
};

const inputCls =
  "w-full min-h-11 px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent";

/**
 * The transfer block under the payment chips (doc 15 spec 12 §4.3, 08 §4.2):
 * receiving account, what the customer is shown (InstaPay QR / wallet
 * number), optional payer hints, the split into parts (+ cash remainder) and
 * the WhatsApp share of the payment link. `mode="settle"` (the ledger's settle
 * modal) keeps only the account and payer hints: no QR, split or share.
 * Controlled: the parent owns the draft and runs `validateTransfer`.
 */
export function TransferPanel({
  mode = "pos",
  method,
  total,
  accounts,
  accountsState,
  canManageAccounts,
  value,
  onChange,
  customerPhone,
  shopName,
  errors,
  warnings,
}: {
  mode?: "pos" | "settle";
  method: DigitalMethod;
  total: number;
  /** Already filtered for the method (accountsForMethod). */
  accounts: readonly AccountLike[];
  accountsState: AccountsState;
  canManageAccounts: boolean;
  value: TransferDraft;
  onChange: (next: TransferDraft) => void;
  customerPhone?: string;
  shopName?: string;
  errors: TransferIssue<TransferErrorCode>[];
  warnings: TransferIssue<TransferWarningCode>[];
}) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.collections.pos as Record<string, string>;
  const providers = dict.app.collections.vocab.providers as Record<string, string>;
  const pos = mode === "pos";
  const ids = pos
    ? { account: "pos-collection-account-", payer: "pos-collection-payer", ref: "pos-collection-ref" }
    : { account: "settle-collection-account-", payer: "settle-payer", ref: "settle-ref" };

  const known = accountsState !== "unknown";
  const accountIds = useMemo(() => new Set(accounts.map((a) => a.id)), [accounts]);
  const def = useMemo(() => defaultAccountFor(accounts, method), [accounts, method]);

  // Preselect the POS default when nothing is picked, and drop a picked
  // account that left the list (branch switch, archive, method change;
  // 08 §4.2 items 2 and 10). Only with a known list.
  useEffect(() => {
    if (!known) return;
    let next = value;
    if (next.parts.length === 0) {
      if (next.accountId && !accountIds.has(next.accountId)) next = { ...next, accountId: null };
      if (!next.accountId && def) next = { ...next, accountId: def.id };
    } else if (next.parts.some((p) => p.accountId && !accountIds.has(p.accountId))) {
      next = {
        ...next,
        parts: next.parts.map((p) => (p.accountId && !accountIds.has(p.accountId) ? { ...p, accountId: null } : p)),
      };
    }
    if (next !== value) onChange(next);
  }, [known, accountIds, def, value, onChange]);

  const picked = value.parts.length === 0 ? accounts.find((a) => a.id === value.accountId) ?? null : null;
  const errorsFor = (part: number | null) => errors.filter((e) => e.part === part);
  const warningsFor = (part: number | null) => warnings.filter((w) => w.part === part);
  const renderIssues = (part: number | null) => (
    <>
      {errorsFor(part).map((e) => (
        <p key={`e-${e.code}`} role="alert" className="text-[11px] text-danger">
          {t[ERROR_KEY[e.code]] ?? e.code}
        </p>
      ))}
      {warningsFor(part).map((w) => (
        <p key={`w-${w.code}`} className="text-[11px] text-orange-700 flex items-center gap-1">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          {t[WARNING_KEY[w.code]] ?? w.code}
        </p>
      ))}
    </>
  );

  const shareHref =
    pos && picked?.ipaLink && isValidIpaLink(picked.ipaLink) && customerPhone?.trim()
      ? buildWhatsAppLink(
          customerPhone.trim(),
          (t.shareText ?? "")
            .replace("{shop}", shopName?.trim() || "")
            .replace("{link}", picked.ipaLink),
        )
      : null;

  const remainderPt = cashRemainder(total, value);
  const canSplit = pos && known && accounts.length > 0;

  return (
    <div className="mt-2 rounded-lg border border-accent/30 bg-accent-light/20 p-3 space-y-3">
      {/* 1. Receiving account (single mode) */}
      {value.parts.length === 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-text-primary">{t.pickAccount}</p>
          {accounts.length > 0 && (
            <AccountPicker
              name={`${mode}-collection-account`}
              ariaLabel={t.pickAccount}
              accounts={accounts}
              value={value.accountId}
              onChange={(id) => onChange({ ...value, accountId: id })}
              testIdPrefix={ids.account}
            />
          )}
          {known && accounts.length === 0 && (
            <div className="text-[11px] text-text-secondary space-y-0.5">
              <p>{t.noAccounts}</p>
              {canManageAccounts && (
                <Link href="/settings/collections" className="text-accent hover:underline">
                  {t.noAccountsOwnerHint}
                </Link>
              )}
            </div>
          )}
          {accountsState === "unknown" && <p className="text-[11px] text-text-secondary">{t.accountsUnknown}</p>}
          {accountsState === "cached" && <p className="text-[11px] text-orange-700">{t.offlineAccounts}</p>}
          {renderIssues(null)}
        </div>
      )}

      {/* 2. What the customer is shown */}
      {pos && picked && (
        <div className="flex flex-col items-center gap-1.5 text-center">
          {picked.rail === "instapay" && picked.ipaLink && isValidIpaLink(picked.ipaLink) ? (
            <>
              <IpaQr link={picked.ipaLink} size={200} label={t.scanHint} testId="pos-collection-qr" />
              {picked.ipaHandle && (
                <p className="text-sm font-semibold text-text-primary" dir="ltr">
                  {picked.ipaHandle}
                </p>
              )}
              <p className="text-[11px] text-text-secondary">{t.scanHint}</p>
            </>
          ) : picked.rail === "wallet" && picked.walletMsisdn ? (
            <>
              <p
                data-testid="pos-collection-number"
                className="text-2xl font-bold tabular-nums text-text-primary"
                dir="ltr"
              >
                {formatWalletNumber(picked.walletMsisdn)}
              </p>
              <p className="text-[11px] text-text-secondary">
                {t.sendToNumber} · {providers[picked.provider] ?? picked.provider}
              </p>
            </>
          ) : picked.ipaHandle ? (
            <p className="text-sm font-semibold text-text-primary" dir="ltr">
              {picked.ipaHandle}
            </p>
          ) : null}
          {picked.holderName && (
            <p className="text-[11px] text-text-primary">{(t.checkName ?? "").replace("{name}", picked.holderName)}</p>
          )}
        </div>
      )}
      <p className="text-[11px] font-medium text-danger">{t.noScreenshot}</p>

      {/* 3. Payer hints (single mode) */}
      {value.parts.length === 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="block">
            <span className="block text-[11px] text-text-secondary mb-0.5">{t.payerLast4Label}</span>
            <input
              data-testid={ids.payer}
              inputMode="numeric"
              maxLength={4}
              dir="ltr"
              autoComplete="off"
              value={value.payerPhoneLast4}
              onChange={(e) => onChange({ ...value, payerPhoneLast4: e.target.value })}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="block text-[11px] text-text-secondary mb-0.5">{t.referenceLabel}</span>
            <input
              data-testid={ids.ref}
              maxLength={16}
              dir="ltr"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={value.payerReference}
              onChange={(e) => onChange({ ...value, payerReference: e.target.value })}
              className={inputCls}
            />
            <span className="block text-[10px] text-text-secondary mt-0.5">{t.referenceHint}</span>
          </label>
        </div>
      )}

      {/* 4. Split into parts */}
      {pos && value.parts.length > 0 && (
        <div className="space-y-3">
          {value.parts.map((p, i) => {
            const n = i + 1;
            const setPart = (patch: Partial<typeof p>) =>
              onChange({ ...value, parts: value.parts.map((q, j) => (j === i ? { ...q, ...patch } : q)) });
            return (
              <div key={n} className="rounded-lg border border-border bg-white p-2.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-text-primary">{(t.partTitle ?? "").replace("{n}", String(n))}</p>
                  <button
                    type="button"
                    data-testid={`pos-collection-part-${n}-remove`}
                    onClick={() => onChange(removePart(value, n, total))}
                    className="inline-flex items-center gap-1 min-h-11 px-2 text-[11px] text-danger hover:underline"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {t.removePart}
                  </button>
                </div>
                <AccountPicker
                  name={`pos-collection-part-${n}`}
                  ariaLabel={t.pickAccount}
                  accounts={accounts}
                  value={p.accountId}
                  onChange={(id) => setPart({ accountId: id })}
                  testIdPrefix={`pos-collection-part-${n}-account-`}
                />
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <label className="block">
                    <span className="block text-[11px] text-text-secondary mb-0.5">{t.partAmount}</span>
                    <input
                      data-testid={`pos-collection-part-${n}-amount`}
                      type="number"
                      step="0.01"
                      min={0}
                      inputMode="decimal"
                      dir="ltr"
                      value={p.amount}
                      onChange={(e) => setPart({ amount: e.target.value })}
                      className={inputCls}
                    />
                  </label>
                  <label className="block">
                    <span className="block text-[11px] text-text-secondary mb-0.5">{t.payerLast4Label}</span>
                    <input
                      data-testid={`pos-collection-part-${n}-payer`}
                      inputMode="numeric"
                      maxLength={4}
                      dir="ltr"
                      autoComplete="off"
                      value={p.payerPhoneLast4}
                      onChange={(e) => setPart({ payerPhoneLast4: e.target.value })}
                      className={inputCls}
                    />
                  </label>
                  <label className="block">
                    <span className="block text-[11px] text-text-secondary mb-0.5">{t.referenceLabel}</span>
                    <input
                      data-testid={`pos-collection-part-${n}-ref`}
                      maxLength={16}
                      dir="ltr"
                      autoCapitalize="none"
                      autoComplete="off"
                      spellCheck={false}
                      value={p.payerReference}
                      onChange={(e) => setPart({ payerReference: e.target.value })}
                      className={inputCls}
                    />
                  </label>
                </div>
                {renderIssues(n)}
              </div>
            );
          })}
          <p data-testid="pos-collection-cash-remainder" className="text-xs font-semibold text-text-primary">
            {(t.cashRemainder ?? "").replace("{amount}", formatCurrency(remainderPt / 100, locale))}
          </p>
          {renderIssues(null)}
        </div>
      )}

      {canSplit && (
        <div className="flex flex-wrap gap-2">
          {value.parts.length === 0 && (
            <button
              type="button"
              data-testid="pos-collection-split"
              onClick={() => onChange(startSplit(value, total, def?.id ?? null))}
              className="inline-flex items-center gap-1 min-h-11 px-3 rounded-lg border border-accent text-accent text-xs font-semibold hover:bg-accent-light"
            >
              {t.split}
            </button>
          )}
          {value.parts.length < MAX_PARTS && (
            <button
              type="button"
              data-testid="pos-collection-add-part"
              onClick={() => onChange(addPart(value, total, def?.id ?? null))}
              className="inline-flex items-center gap-1 min-h-11 px-3 rounded-lg border border-border text-text-secondary text-xs font-semibold hover:border-accent/50"
            >
              <Plus className="w-3.5 h-3.5" />
              {t.addPart}
            </button>
          )}
        </div>
      )}

      {/* 5. Share the payment link */}
      {shareHref && (
        <a
          href={shareHref}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="pos-collection-share"
          className="inline-flex items-center gap-1.5 min-h-11 px-3 rounded-lg bg-success-light text-success text-xs font-semibold hover:opacity-90"
        >
          <MessageCircle className="w-4 h-4" />
          {t.share}
        </a>
      )}
    </div>
  );
}
