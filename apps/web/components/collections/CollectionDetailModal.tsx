"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency, formatDateTime } from "@/lib/i18n/format";
import { useCollection, type CollectionsAccessState } from "@/hooks/useCollections";
import type { CollectionDetail } from "@/lib/api/collections";
import { CollectionPill } from "./CollectionPill";
import { ConfirmDialog as CollectionConfirmDialog } from "./ConfirmDialog";
import { RejectDialog } from "./RejectDialog";
import { ReopenDialog } from "./ReopenDialog";
import { EditCollectionDialog } from "./EditCollectionDialog";
import { canDecide, reopenAllowed, reopenUntil } from "./rules";

function subscribeOnline(cb: () => void): () => void {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

/** navigator.onLine with live updates (no outbox drain loop). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/** Decision dialogs render at the body, outside the detail modal's
 *  animated (transformed) box, so their fixed backdrop covers the viewport. */
const noopSubscribe = () => () => {};
function BodyPortal({ children }: { children: ReactNode }) {
  // false on the server and during hydration, true in the browser after.
  const client = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return client ? createPortal(children, document.body) : null;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className="text-text-secondary shrink-0">{label}</span>
      <span className="text-text-primary text-end min-w-0 break-words">{children}</span>
    </div>
  );
}

function Block({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border px-3 py-2">
      {title && <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary pt-1">{title}</h3>}
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

type Dialog = "confirm" | "reject" | "reopen" | "edit" | null;

/**
 * The collection detail (`data-testid="collection-detail"`, doc 15 spec 12
 * §4.7), opened by `?id=`: head, account, sale, payer, decision, flags,
 * history, and the confirm / reject / reopen / edit actions — each behind
 * `canDecide()` / `reopenAllowed()` and online only. The server re-checks
 * every gate (four-eyes, 7-day reopen window, permissions).
 */
export function CollectionDetailModal({
  id,
  access,
  onClose,
  onDone,
}: {
  id: string | null;
  access: CollectionsAccessState;
  onClose: () => void;
  onDone: (done: "confirmed" | "rejected" | "reopened" | "saved") => void;
}) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.collections.detail;
  const web = dict.app.collections.web.detail;
  const vocab = dict.app.collections.vocab;
  const q = useCollection(id);
  const online = useOnline();
  // The page keys this modal by `id`, so the open dialog resets per collection.
  const [dialog, setDialog] = useState<Dialog>(null);
  // Read once per opening (render must stay pure): the 7-day reopen window.
  const [nowMs] = useState(() => Date.now());

  if (!id) return null;
  const c = q.data as CollectionDetail | undefined;

  const finish = (done: "confirmed" | "rejected" | "reopened" | "saved") => {
    setDialog(null);
    onDone(done);
    void q.refetch();
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
        <p className="text-sm text-text-secondary">{dict.app.collections.errors.COLLECTION_NOT_FOUND}</p>
        <Button variant="secondary" onClick={() => void q.refetch()}>
          {dict.app.collections.web.inbox.retry}
        </Button>
      </div>
    );
  } else {
    const decide = canDecide(c, access);
    const showDecide = c.status === "pending" && (decide.allowed || decide.reason === "self");
    const canReopen = reopenAllowed(c, access.isOwner, nowMs);
    const canEdit =
      c.status === "pending" && (access.canConfirm || (c.recordedBy?.id != null && c.recordedBy.id === access.userId));
    const methodLabel = (dict.app.catalog.payment as Record<string, string>)[c.method] ?? c.method;
    const lastDecision = [...c.events].reverse().find((e) => e.kind === "confirmed" || e.kind === "rejected" || e.kind === "auto_confirmed");
    const decisionNote = typeof lastDecision?.details?.note === "string" ? (lastDecision.details.note as string) : null;
    const until = reopenUntil(c);
    const eventLabels = web.events as Record<string, string>;
    const actionsDisabled = !online;

    body = (
      <div className="space-y-3">
        {/* Head */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-2xl font-bold tabular-nums text-text-primary">{formatCurrency(c.amount, locale)}</span>
          <CollectionPill status={c.status} />
          <span className="text-xs text-text-secondary">{methodLabel}</span>
          {c.isStale && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-danger-light text-danger">
              {dict.app.collections.inbox.staleBadge}
            </span>
          )}
        </div>

        <Block>
          {c.account ? (
            <>
              <Row label={t.account}>
                <span dir="auto">{c.account.label}</span>{" "}
                <span dir="ltr" className="font-mono text-xs text-text-secondary">
                  {c.account.mask}
                </span>
              </Row>
              <Row
                label={
                  c.account.rail === "wallet"
                    ? dict.app.collectionsSettings.form.fields.provider.wallet
                    : dict.app.collectionsSettings.form.fields.provider.bank
                }
              >
                {(vocab.providers as Record<string, string>)[c.account.provider] ?? c.account.provider}
              </Row>
            </>
          ) : (
            <Row label={t.account}>{dict.app.collections.inbox.row.noAccount}</Row>
          )}
        </Block>

        <Block title={t.blockTitle}>
          {c.sourceType === "settlement" ? (
            <Row label={t.invoice}>{t.settlement}</Row>
          ) : (
            c.invoiceId && (
              <Row label={t.invoice}>
                <span dir="ltr" className="font-mono">
                  {c.invoiceId}
                </span>
              </Row>
            )
          )}
          {c.customerPhone && (
            <Row label={t.customer}>
              <Link
                href={`/customers/${encodeURIComponent(c.customerPhone)}`}
                className="inline-flex items-center min-h-11 text-accent hover:underline"
                title={web.openCustomer}
              >
                <span dir="ltr">{c.customerPhone}</span>
              </Link>
            </Row>
          )}
          {c.partsCount > 1 && (
            <Row label={t.blockTitle}>
              {dict.app.collections.inbox.row.part
                .replace("{n}", String(c.partNo))
                .replace("{total}", String(c.partsCount))}
            </Row>
          )}
          <Row label={t.rungAt}>{formatDateTime(c.rungAt, locale)}</Row>
          {c.recordedBy?.name && <Row label={t.recordedBy}>{c.recordedBy.name}</Row>}
        </Block>

        {(c.payerPhoneLast4 || c.payerReference) && (
          <Block>
            {c.payerPhoneLast4 && (
              <Row label={t.payerLast4}>
                <span dir="ltr" className="tabular-nums">
                  {c.payerPhoneLast4}
                </span>
              </Row>
            )}
            {c.payerReference && (
              <Row label={t.reference}>
                <span dir="ltr" className="font-mono">
                  {c.payerReference}
                </span>
              </Row>
            )}
          </Block>
        )}

        {c.decidedAt && (
          <Block>
            <Row label={t.decidedBy}>{c.decidedBy?.name ?? web.system}</Row>
            <Row label={t.decidedAt}>{formatDateTime(c.decidedAt, locale)}</Row>
            {c.rejectReason && (
              <Row label={t.reason}>{(vocab.reasons as Record<string, string>)[c.rejectReason] ?? c.rejectReason}</Row>
            )}
            {c.rejectOutcome && (
              <Row label={t.outcome}>{(vocab.outcomes as Record<string, string>)[c.rejectOutcome] ?? c.rejectOutcome}</Row>
            )}
            {decisionNote && <Row label={t.note}>{decisionNote}</Row>}
          </Block>
        )}

        {c.flags.length > 0 && (
          <Block title={t.flags}>
            <div className="flex flex-wrap gap-1 py-1.5">
              {c.flags.map((f) => (
                <span key={f} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-text-secondary">
                  {(vocab.flags as Record<string, string>)[f] ?? f}
                </span>
              ))}
            </div>
          </Block>
        )}

        {c.matchedCredit && (
          <Block title={t.matchedCredit}>
            <Row label={t.amount}>{formatCurrency(c.matchedCredit.amount, locale)}</Row>
            <Row label={t.rungAt}>{formatDateTime(c.matchedCredit.occurredAt, locale)}</Row>
            {c.matchedCredit.payerNameMasked && <Row label={t.customer}>{c.matchedCredit.payerNameMasked}</Row>}
          </Block>
        )}

        <Block title={web.historyTitle}>
          <ol className="py-1">
            {c.events.map((e, i) => (
              <li key={`${e.kind}-${e.createdAt}-${i}`} className="flex items-start justify-between gap-3 py-1 text-xs">
                <span className="text-text-primary">
                  {eventLabels[e.kind] ?? e.kind}
                  <span className="text-text-secondary"> · {e.actor?.name ?? web.system}</span>
                </span>
                <span className="text-text-secondary whitespace-nowrap">{formatDateTime(e.createdAt, locale)}</span>
              </li>
            ))}
          </ol>
        </Block>

        {/* Actions */}
        {(showDecide || canReopen || canEdit) && (
          <div className="space-y-2 pt-2 border-t border-border">
            {decide.reason === "self" && (
              <p className="text-xs text-orange-700 bg-orange-50 rounded-lg px-3 py-2">{t.selfDecisionBlocked}</p>
            )}
            {actionsDisabled && <p className="text-xs text-text-secondary">{t.onlineOnly}</p>}
            {canReopen && until && (
              <p className="text-[11px] text-text-secondary">
                {t.reopenUntil.replace("{date}", formatDateTime(until, locale))}
              </p>
            )}
            <div className="flex flex-wrap gap-2 justify-end">
              {canEdit && (
                <Button
                  variant="ghost"
                  className="min-h-11"
                  data-testid="collection-edit"
                  disabled={actionsDisabled}
                  onClick={() => setDialog("edit")}
                >
                  {t.edit}
                </Button>
              )}
              {canReopen && (
                <Button
                  variant="secondary"
                  className="min-h-11"
                  data-testid="collection-reopen"
                  disabled={actionsDisabled}
                  onClick={() => setDialog("reopen")}
                >
                  {t.reopen}
                </Button>
              )}
              {showDecide && (
                <>
                  <Button
                    variant="danger"
                    className="min-h-11"
                    data-testid="collection-reject"
                    disabled={actionsDisabled || !decide.allowed}
                    onClick={() => setDialog("reject")}
                  >
                    {t.reject}
                  </Button>
                  <Button
                    className="min-h-11"
                    data-testid="collection-confirm"
                    disabled={actionsDisabled || !decide.allowed}
                    onClick={() => setDialog("confirm")}
                  >
                    {t.confirm}
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        <BodyPortal>
        <CollectionConfirmDialog
          collection={c}
          open={dialog === "confirm"}
          onClose={() => setDialog(null)}
          onDone={finish}
          onStale={() => void q.refetch()}
        />
        <RejectDialog
          collection={c}
          open={dialog === "reject"}
          onClose={() => setDialog(null)}
          onDone={finish}
          onStale={() => void q.refetch()}
          noteMax={access.config?.limits.noteMaxLength ?? 280}
        />
        <ReopenDialog
          collection={c}
          open={dialog === "reopen"}
          onClose={() => setDialog(null)}
          onDone={finish}
          onStale={() => void q.refetch()}
        />
        {dialog === "edit" && (
          <EditCollectionDialog
            collection={c}
            open
            onClose={() => setDialog(null)}
            onDone={finish}
            onStale={() => void q.refetch()}
          />
        )}
        </BodyPortal>
      </div>
    );
  }

  return (
    // While a decision dialog is open, Escape / the backdrop close only it.
    <Modal isOpen onClose={dialog ? () => setDialog(null) : onClose} title={t.title} className="max-w-xl">
      <div data-testid="collection-detail">{body}</div>
    </Modal>
  );
}
