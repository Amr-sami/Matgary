"use client";

import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency, formatDateTime } from "@/lib/i18n/format";
import type { CollectionDTO } from "@/lib/api/collections";
import { CollectionPill } from "./CollectionPill";

/**
 * One inbox row, `collections-row-<id>` (doc 15 spec 12 §4.7): a button that
 * opens the detail (`?id=`). A grid row from `md:`, a stacked card below.
 */
export function CollectionRow({
  c,
  showBranch,
  branchName,
  onOpen,
}: {
  c: CollectionDTO;
  showBranch: boolean;
  branchName?: string | null;
  onOpen: (id: string) => void;
}) {
  const dict = useDictionary();
  const locale = useLocale();
  const inbox = dict.app.collections.inbox;
  const vocab = dict.app.collections.vocab;
  const providers = vocab.providers as Record<string, string>;
  const flags = vocab.flags as Record<string, string>;
  const methodLabel = (dict.app.catalog.payment as Record<string, string>)[c.method] ?? c.method;

  return (
    <li>
      <button
        type="button"
        data-testid={`collections-row-${c.id}`}
        onClick={() => onOpen(c.id)}
        className="w-full text-start px-4 py-3 hover:bg-bg-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent transition-colors grid gap-1.5 md:grid-cols-[minmax(7rem,auto)_1fr_auto] md:items-center md:gap-4"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-bold tabular-nums text-text-primary">
            {formatCurrency(c.amount, locale)}
          </span>
          <CollectionPill status={c.status} />
          {c.isStale && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-danger-light text-danger">
              {inbox.staleBadge}
            </span>
          )}
        </div>
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm text-text-primary truncate">
            <span dir="auto">{c.account ? c.account.label : inbox.row.noAccount}</span>
            {c.account && (
              <span className="text-text-secondary"> · {providers[c.account.provider] ?? c.account.provider}</span>
            )}
            <span className="text-text-secondary"> · {methodLabel}</span>
          </p>
          <p className="text-[11px] text-text-secondary flex flex-wrap gap-x-2 gap-y-0.5">
            {c.sourceType === "settlement" ? (
              <span>{inbox.row.settlement}</span>
            ) : c.invoiceId ? (
              <span dir="ltr" className="font-mono">
                {c.invoiceId}
              </span>
            ) : null}
            {c.partsCount > 1 && (
              <span>
                {inbox.row.part.replace("{n}", String(c.partNo)).replace("{total}", String(c.partsCount))}
              </span>
            )}
            {c.recordedBy?.name && <span>{inbox.row.recordedBy.replace("{name}", c.recordedBy.name)}</span>}
            {c.payerPhoneLast4 && (
              <span dir="ltr" className="tabular-nums">
                •••• {c.payerPhoneLast4}
              </span>
            )}
            {c.payerReference && (
              <span dir="ltr" className="font-mono">
                #{c.payerReference}
              </span>
            )}
            {showBranch && branchName && <span>{branchName}</span>}
          </p>
          {c.flags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {c.flags.map((f) => (
                <span key={f} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-text-secondary">
                  {flags[f] ?? f}
                </span>
              ))}
            </div>
          )}
        </div>
        <span className="text-[11px] text-text-secondary whitespace-nowrap">{formatDateTime(c.rungAt, locale)}</span>
      </button>
    </li>
  );
}
