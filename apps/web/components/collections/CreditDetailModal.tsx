"use client";

import { useRef, useState, type ReactNode } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency, formatDateTime } from "@/lib/i18n/format";
import { useCredit, useCreditActions, type CollectionsAccessState } from "@/hooks/useCollections";
import { newIdempotencyKey, type CollectionCandidate, type CreditDetailDTO } from "@/lib/api/collections";
import { IGNORE_REASON_VALUES, type IgnoreReason } from "@matgary/domain/collections/types";
import { CollectionPill } from "./CollectionPill";
import { useOnline } from "./CollectionDetailModal";
import { payerText } from "./CreditsList";
import { errorCode, errorCopy } from "./copy";
import { canMatch, creditsAccess } from "./rules";
import { cn } from "@/lib/utils";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className="text-text-secondary shrink-0">{label}</span>
      <span className="text-text-primary text-end min-w-0 break-words">{children}</span>
    </div>
  );
}

/** Codes after which the credit or the collection changed under us. */
const STALE_CODES = new Set(["CREDIT_ALREADY_MATCHED", "COLLECTION_NOT_PENDING", "CREDIT_NOT_MATCHABLE"]);

/**
 * One bank / wallet message (doc 15 spec 12 §4.7, M2), opened by
 * `?credit=<id>`: the parsed fields, the template status, the ranked
 * candidates (≤ 10) each with `credit-match-<collectionId>` (disabled with
 * `web.credits.selfRecorded` when the viewer recorded that sale and is not
 * the owner), `credit-ignore` → reason chips, and the owner-only
 * `credit-show-raw` (each view is logged server-side as
 * `collection.raw_view`). Every action is online-only; one Idempotency-Key
 * per action and opening. The server re-checks every gate.
 */
export function CreditDetailModal({
  id,
  access,
  onClose,
  onDone,
}: {
  id: string | null;
  access: CollectionsAccessState;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.collections.credits;
  const detailT = dict.app.collections.detail;
  const web = dict.app.collections.web;
  const vocab = dict.app.collections.vocab;
  const providers = vocab.providers as Record<string, string>;
  const channels = vocab.channels as Record<string, string>;
  const holdReasons = vocab.holdReasons as Record<string, string>;
  const ignoreReasons = vocab.ignoreReasons as Record<string, string>;
  const templateStatus = web.credits.templateStatus as Record<string, string>;
  const errorsT = dict.app.collections.errors as Record<string, string>;

  const q = useCredit(id);
  const [showRaw, setShowRaw] = useState(false);
  const rawQ = useCredit(showRaw ? id : null, { includeRaw: true });
  const { match, ignore } = useCreditActions();
  const online = useOnline();
  const rights = creditsAccess(access);
  // The page keys this modal by id: keys and panels reset per credit.
  const matchKeys = useRef(new Map<string, string>());
  const [ignoreKey, setIgnoreKey] = useState<string | null>(null);
  const [ignoreReason, setIgnoreReason] = useState<IgnoreReason | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!id) return null;
  const c = q.data as CreditDetailDTO | undefined;

  const fail = (e: unknown) => {
    const code = errorCode(e);
    if (code && STALE_CODES.has(code)) void q.refetch();
    setError(errorCopy(code, [errorsT], detailT.actionFailed));
  };

  const doMatch = async (cand: CollectionCandidate) => {
    setError(null);
    let key = matchKeys.current.get(cand.id);
    if (!key) {
      key = newIdempotencyKey();
      matchKeys.current.set(cand.id, key);
    }
    try {
      await match.mutateAsync({ id, collectionId: cand.id, key });
      onDone(t.done.matched);
    } catch (e) {
      fail(e);
    }
  };

  const doIgnore = async () => {
    if (!ignoreReason || !ignoreKey) return;
    setError(null);
    try {
      await ignore.mutateAsync({ id, reason: ignoreReason, key: ignoreKey });
      onDone(t.done.ignored);
    } catch (e) {
      fail(e);
    }
  };

  let body: ReactNode;
  if (q.isPending) {
    body = (
      <div className="py-10 flex justify-center">
        <LoadingSpinner />
      </div>
    );
  } else if (!c) {
    body = (
      <div className="py-6 text-center space-y-3">
        <p className="text-sm text-text-secondary">{errorsT.CREDIT_NOT_FOUND}</p>
        <Button variant="secondary" onClick={() => void q.refetch()}>
          {web.inbox.retry}
        </Button>
      </div>
    );
  } else {
    const open = c.state === "unmatched" || c.state === "held";
    const payer = payerText(c);
    const busy = match.isPending || ignore.isPending;
    const actionsDisabled = !online || busy;
    const raw = rawQ.data?.raw ?? null;

    body = (
      <div className="space-y-3">
        {/* Head */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-2xl font-bold tabular-nums text-text-primary">{formatCurrency(c.amount, locale)}</span>
          {c.state === "held" && c.holdReason && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-orange-100 text-orange-700">
              {holdReasons[c.holdReason] ?? c.holdReason}
            </span>
          )}
          <span
            data-testid={`credit-template-${c.templateStatus}`}
            className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-gray-100 text-text-secondary"
          >
            {templateStatus[c.templateStatus] ?? c.templateStatus}
          </span>
        </div>
        {c.state === "matched" && (
          <p data-testid="credit-state-matched" className="text-sm font-medium text-success">
            {t.done.matched}
          </p>
        )}
        {c.state === "ignored" && (
          <p data-testid="credit-state-ignored" className="text-sm font-medium text-text-secondary">
            {t.done.ignored}
            {c.ignoredReason ? ` — ${ignoreReasons[c.ignoredReason] ?? c.ignoredReason}` : ""}
          </p>
        )}

        <section className="rounded-xl border border-border px-3 py-2 divide-y divide-border">
          <Row label={detailT.account}>
            {c.account ? (
              <>
                <span dir="auto">{c.account.label}</span>
                <span className="text-text-secondary"> · {providers[c.account.provider] ?? c.account.provider}</span>
                <span dir="ltr" className="text-text-secondary">
                  {" "}
                  {c.account.mask}
                </span>
              </>
            ) : (
              dict.app.collections.inbox.row.noAccount
            )}
          </Row>
          <Row label={t.occurredAt}>{formatDateTime(c.occurredAt, locale)}</Row>
          <Row label={t.channels}>
            {c.channels.map((ch) => channels[ch] ?? ch).join(" · ")}
            {c.sender && (
              <span dir="ltr" className="font-mono text-text-secondary">
                {" · "}
                {c.sender}
              </span>
            )}
          </Row>
          {payer && (
            <Row label={detailT.payer}>
              <span dir="auto">{payer}</span>
            </Row>
          )}
          {c.operatorReference && (
            <Row label={detailT.reference}>
              <span dir="ltr" className="font-mono">
                {c.operatorReference}
              </span>
            </Row>
          )}
        </section>

        {/* Candidates */}
        {open && (
          <section className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">{t.candidates}</h3>
            {c.candidates.length === 0 ? (
              <p data-testid="credit-no-candidates" className="text-sm text-text-secondary">
                {t.noCandidates}
              </p>
            ) : (
              <ul className="space-y-2">
                {c.candidates.map((cand) => {
                  const allowed = canMatch(cand, access);
                  const amountDiffers = cand.amount !== c.amount;
                  const accountDiffers = !!(cand.accountId && c.account && cand.accountId !== c.account.id);
                  return (
                    <li
                      key={cand.id}
                      data-testid={`credit-candidate-${cand.id}`}
                      className={cn(
                        "rounded-xl border px-3 py-2 space-y-1.5",
                        c.suggestedCollection?.id === cand.id ? "border-accent" : "border-border",
                      )}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold tabular-nums text-text-primary">
                          {formatCurrency(cand.amount, locale)}
                        </span>
                        <CollectionPill status={cand.status} />
                        {cand.invoiceId && (
                          <span dir="ltr" className="text-xs font-mono text-text-secondary">
                            {cand.invoiceId}
                          </span>
                        )}
                        <span className="text-[11px] text-text-secondary ms-auto">
                          {formatDateTime(cand.rungAt, locale)}
                        </span>
                      </div>
                      <p className="text-[11px] text-text-secondary flex flex-wrap gap-x-2">
                        {cand.recordedBy?.name && (
                          <span>{dict.app.collections.inbox.row.recordedBy.replace("{name}", cand.recordedBy.name)}</span>
                        )}
                        {cand.payerPhoneLast4 && (
                          <span dir="ltr" className="tabular-nums">
                            •••• {cand.payerPhoneLast4}
                          </span>
                        )}
                        {cand.payerReference && (
                          <span dir="ltr" className="font-mono">
                            #{cand.payerReference}
                          </span>
                        )}
                      </p>
                      {(amountDiffers || accountDiffers) && (
                        <p className="text-[11px] font-medium text-orange-700">
                          {[amountDiffers ? t.amountDiffers : null, accountDiffers ? t.accountDiffers : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      )}
                      {access.canConfirm && (
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            data-testid={`credit-match-${cand.id}`}
                            className="min-h-11 lg:min-h-0"
                            disabled={!allowed || actionsDisabled}
                            loading={match.isPending && match.variables?.collectionId === cand.id}
                            onClick={() => void doMatch(cand)}
                          >
                            {t.match}
                          </Button>
                          {!allowed && <span className="text-[11px] text-text-secondary">{web.credits.selfRecorded}</span>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {/* Ignore */}
        {open && rights.canIgnore && (
          <section className="space-y-2">
            {ignoreKey == null ? (
              <Button
                variant="ghost"
                data-testid="credit-ignore"
                className="min-h-11 lg:min-h-0"
                disabled={actionsDisabled}
                onClick={() => setIgnoreKey(newIdempotencyKey())}
              >
                {t.ignore}
              </Button>
            ) : (
              <div className="rounded-xl border border-border px-3 py-2 space-y-2">
                <h3 className="text-sm font-semibold text-text-primary">{t.ignoreSheet.title}</h3>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t.ignoreSheet.title}>
                  {IGNORE_REASON_VALUES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      role="radio"
                      aria-checked={ignoreReason === r}
                      data-testid={`credit-ignore-reason-${r}`}
                      onClick={() => setIgnoreReason(r)}
                      className={cn(
                        "min-h-11 px-3 rounded-lg border text-sm",
                        ignoreReason === r ? "bg-accent text-white border-accent" : "bg-white text-text-secondary border-border",
                      )}
                    >
                      {ignoreReasons[r] ?? r}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" onClick={() => setIgnoreKey(null)} disabled={ignore.isPending}>
                    {dict.app.collectionsSettings.form.cancel}
                  </Button>
                  <Button
                    variant="danger"
                    data-testid="credit-ignore-submit"
                    className="min-h-11 lg:min-h-0"
                    disabled={!ignoreReason || actionsDisabled}
                    loading={ignore.isPending}
                    onClick={() => void doIgnore()}
                  >
                    {t.ignoreSheet.submit}
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}

        {!online && open && <p className="text-xs text-text-secondary">{detailT.onlineOnly}</p>}
        {error && (
          <p role="alert" className="text-xs text-danger bg-danger-light px-3 py-2 rounded-lg">
            {error}
          </p>
        )}

        {/* Raw text — owner only, logged */}
        {rights.canShowRaw && (
          <section className="space-y-2">
            {!showRaw ? (
              <Button
                variant="ghost"
                data-testid="credit-show-raw"
                className="min-h-11 lg:min-h-0"
                disabled={!online}
                onClick={() => setShowRaw(true)}
              >
                {web.credits.showRaw}
              </Button>
            ) : rawQ.isPending ? (
              <div className="py-3 flex justify-center">
                <LoadingSpinner />
              </div>
            ) : raw ? (
              <div data-testid="credit-raw" className="rounded-xl border border-border bg-bg-main px-3 py-2 space-y-1">
                {(raw.title || raw.subtitle) && (
                  <p className="text-xs font-semibold text-text-primary" dir="auto">
                    {[raw.title, raw.subtitle].filter(Boolean).join(" · ")}
                  </p>
                )}
                <pre dir="auto" className="text-xs whitespace-pre-wrap break-words font-sans text-text-primary">
                  {raw.body}
                </pre>
                <p className="text-[11px] text-text-secondary">{web.credits.rawNote}</p>
              </div>
            ) : (
              <p className="text-xs text-text-secondary">{web.credits.rawNote}</p>
            )}
          </section>
        )}
      </div>
    );
  }

  return (
    <Modal isOpen onClose={onClose} title={t.title}>
      <div data-testid="credit-detail" className="max-h-[75vh] overflow-y-auto -mx-1 px-1">
        {body}
      </div>
    </Modal>
  );
}
