"use client";

import { useState } from "react";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { Button } from "@/components/ui/Button";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { formatDate, formatDateTime } from "@/lib/i18n/format";
import { useUnrecognised } from "@/hooks/useCollections";
import { errorCode, errorCopy } from "./copy";

/**
 * "Unrecognised messages" (doc 15 spec 12 §4.7, M2, OWNER ONLY — ARCH CR 6),
 * under the credits list: messages the parser could not read, decrypted
 * server-side (`GET /api/collections/unrecognised`, one `collection.raw_view`
 * per page), each with `unrecognised-share-<id>` → `POST …/share` (idempotent;
 * the copy kept for TheStoro is redacted per 03 §D.6 — `shareNote`, subject
 * to 14's review). The caller renders it only for the owner; the server
 * answers 403 to anyone else anyway.
 */
export function UnrecognisedList({ online }: { online: boolean }) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.collections.web.unrecognised;
  const channels = dict.app.collections.vocab.channels as Record<string, string>;
  const { list, share } = useUnrecognised(true);
  const [error, setError] = useState<string | null>(null);
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  const doShare = async (id: string) => {
    setError(null);
    try {
      await share.mutateAsync(id);
    } catch (e) {
      setError(
        errorCopy(
          errorCode(e),
          [dict.app.collections.errors as Record<string, string>],
          dict.app.collections.detail.actionFailed,
        ),
      );
    }
  };

  return (
    <section data-testid="collections-unrecognised" className="bg-white rounded-2xl border border-border overflow-hidden">
      <div className="px-4 py-3 border-b border-border space-y-1">
        <h2 className="text-sm font-semibold text-text-primary">{t.title}</h2>
        <p className="text-xs text-text-secondary">{t.hint}</p>
        <p className="text-[11px] text-text-secondary">{t.shareNote}</p>
      </div>
      {error && (
        <p role="alert" className="mx-4 mt-3 text-xs text-danger bg-danger-light px-3 py-2 rounded-lg">
          {error}
        </p>
      )}
      {list.isPending ? (
        <PageSkeleton variant="list" rows={2} />
      ) : list.isError ? (
        <div className="p-6 text-center space-y-3">
          <p className="text-sm text-text-secondary">{dict.app.collections.inbox.loadFailed}</p>
          <Button variant="secondary" onClick={() => void list.refetch()}>
            {dict.app.collections.web.inbox.retry}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p data-testid="collections-unrecognised-empty" className="px-4 py-8 text-center text-sm text-text-secondary">
          {t.empty}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((m) => (
            <li key={m.id} data-testid={`unrecognised-row-${m.id}`} className="px-4 py-3 space-y-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                {m.sender && (
                  <span dir="ltr" className="font-mono font-semibold text-text-primary">
                    {m.sender}
                  </span>
                )}
                <span className="text-text-secondary">{channels[m.channel] ?? m.channel}</span>
                <span className="text-text-secondary ms-auto">{formatDateTime(m.receivedAt, locale)}</span>
              </div>
              {(m.title || m.subtitle) && (
                <p className="text-xs font-semibold text-text-primary" dir="auto">
                  {[m.title, m.subtitle].filter(Boolean).join(" · ")}
                </p>
              )}
              <pre
                dir="auto"
                className="text-xs whitespace-pre-wrap break-words font-sans text-text-primary bg-bg-main rounded-lg px-3 py-2"
              >
                {m.body}
              </pre>
              <div className="flex flex-wrap items-center gap-2">
                {m.sharedAt ? (
                  <span data-testid={`unrecognised-shared-${m.id}`} className="text-[11px] font-medium text-success">
                    {t.shared.replace("{date}", formatDate(m.expiresAt, locale))}
                  </span>
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      data-testid={`unrecognised-share-${m.id}`}
                      className="min-h-11 lg:min-h-0"
                      disabled={!online || share.isPending}
                      loading={share.isPending && share.variables === m.id}
                      onClick={() => void doShare(m.id)}
                    >
                      {t.share}
                    </Button>
                    <span className="text-[11px] text-text-secondary">
                      {t.expires.replace("{date}", formatDate(m.expiresAt, locale))}
                    </span>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <div className="p-3 border-t border-border flex justify-center">
          <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {dict.app.collections.web.inbox.loadMore}
          </Button>
        </div>
      )}
    </section>
  );
}
