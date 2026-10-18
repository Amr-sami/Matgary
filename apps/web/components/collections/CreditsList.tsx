"use client";

import { useMemo } from "react";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { Button } from "@/components/ui/Button";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { formatCurrency, formatDateTime } from "@/lib/i18n/format";
import { useCredits } from "@/hooks/useCollections";
import type { CreditDTO } from "@/lib/api/collections";

/** The credits tab lists what still needs a person (ARCH CR 3). */
const OPEN_STATES = "unmatched,held";

/**
 * The credits tab (doc 15 spec 12 §4.7, M2): bank / wallet messages that are
 * not matched yet — `GET /api/collections/credits?state=unmatched,held`.
 * Rows `credit-row-<id>` open `?credit=<id>`. The header button
 * `credits-paste` shows for `confirm_collections` (and the owner).
 */
export function CreditsList({
  allBranches,
  canPaste,
  online,
  onOpen,
  onPaste,
}: {
  allBranches: boolean;
  canPaste: boolean;
  online: boolean;
  onOpen: (id: string) => void;
  onPaste: () => void;
}) {
  const dict = useDictionary();
  const credits = dict.app.collections.credits;
  const inbox = dict.app.collections.inbox;
  const web = dict.app.collections.web;
  const filters = useMemo(
    () => ({ state: OPEN_STATES, ...(allBranches ? { branchId: "all" as const } : {}) }),
    [allBranches],
  );
  const q = useCredits(filters);
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  const emptyCopy = (inbox.empty as Record<string, { title: string; hint?: string }>).credits;

  return (
    <div className="bg-white rounded-2xl border border-border overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text-primary me-auto">{credits.title}</h2>
        {canPaste && (
          <Button
            variant="secondary"
            data-testid="credits-paste"
            className="min-h-11 lg:min-h-0"
            disabled={!online}
            title={online ? undefined : dict.app.collections.detail.onlineOnly}
            onClick={onPaste}
          >
            {credits.pasteSheet.title}
          </Button>
        )}
      </div>
      {q.isPending ? (
        <PageSkeleton variant="list" rows={3} />
      ) : q.isError ? (
        <div className="p-6 text-center space-y-3">
          <p className="text-sm text-text-secondary">{online ? inbox.loadFailed : inbox.offline.title}</p>
          <Button variant="secondary" onClick={() => void q.refetch()}>
            {web.inbox.retry}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div data-testid="collections-empty" className="px-4 py-10 text-center">
          <p className="text-sm font-semibold text-text-primary">{emptyCopy?.title}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((c) => (
            <CreditRow key={c.id} c={c} onOpen={onOpen} />
          ))}
        </ul>
      )}
      {q.hasNextPage && (
        <div className="p-3 border-t border-border flex justify-center">
          <Button
            variant="secondary"
            data-testid="credits-load-more"
            loading={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            {web.inbox.loadMore}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Masked payer name, else the payer's last 4 digits, else nothing. */
export function payerText(c: Pick<CreditDTO, "payerName" | "payerNameMasked" | "payerPhoneLast4">): string | null {
  if (c.payerName) return c.payerName;
  if (c.payerNameMasked) return c.payerNameMasked;
  if (c.payerPhoneLast4) return `•••• ${c.payerPhoneLast4}`;
  return null;
}

function CreditRow({ c, onOpen }: { c: CreditDTO; onOpen: (id: string) => void }) {
  const dict = useDictionary();
  const locale = useLocale();
  const credits = dict.app.collections.credits;
  const vocab = dict.app.collections.vocab;
  const providers = vocab.providers as Record<string, string>;
  const channels = vocab.channels as Record<string, string>;
  const holdReasons = vocab.holdReasons as Record<string, string>;
  const payer = payerText(c);
  const suggested = c.suggestedCollection;

  return (
    <li>
      <button
        type="button"
        data-testid={`credit-row-${c.id}`}
        onClick={() => onOpen(c.id)}
        className="w-full text-start px-4 py-3 hover:bg-bg-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent transition-colors grid gap-1.5 md:grid-cols-[minmax(7rem,auto)_1fr_auto] md:items-center md:gap-4"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-bold tabular-nums text-text-primary">{formatCurrency(c.amount, locale)}</span>
          {c.state === "held" && c.holdReason && (
            <span
              data-testid={`credit-hold-${c.holdReason}`}
              className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-orange-100 text-orange-700 whitespace-nowrap"
            >
              {holdReasons[c.holdReason] ?? c.holdReason}
            </span>
          )}
        </div>
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm text-text-primary truncate">
            <span dir="auto">{c.account ? c.account.label : dict.app.collections.inbox.row.noAccount}</span>
            {c.account && (
              <span className="text-text-secondary"> · {providers[c.account.provider] ?? c.account.provider}</span>
            )}
          </p>
          <p className="text-[11px] text-text-secondary flex flex-wrap gap-x-2 gap-y-0.5">
            {payer && (
              <span dir="auto" className="tabular-nums">
                {payer}
              </span>
            )}
            {c.operatorReference && (
              <span dir="ltr" className="font-mono">
                #{c.operatorReference}
              </span>
            )}
            <span>{c.channels.map((ch) => channels[ch] ?? ch).join(" · ")}</span>
          </p>
          {suggested && suggested.invoiceId && (
            <p className="text-[11px] font-semibold text-accent">
              {credits.suggested.replace("{invoice}", suggested.invoiceId)}
            </p>
          )}
        </div>
        <span className="text-[11px] text-text-secondary whitespace-nowrap">{formatDateTime(c.occurredAt, locale)}</span>
      </button>
    </li>
  );
}
