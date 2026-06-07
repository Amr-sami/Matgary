"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { relativeTime } from "./format";
import type { ConversationDTO, ConversationFilter } from "./types";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

interface Props {
  activeId: string | null;
  onSelect: (id: string) => void;
  refreshSignal?: number;
}

const POLL_MS = 10_000;
const PAGE_SIZE = 50;

export function ConversationList({ activeId, onSelect, refreshSignal }: Props) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.whatsappInbox;
  const tabs: { value: ConversationFilter; label: string }[] = [
    { value: "all", label: t.tabs.all },
    { value: "unread", label: t.tabs.unread },
    { value: "archived", label: t.tabs.archived },
  ];
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const [items, setItems] = useState<ConversationDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);

  const filterRef = useRef(filter);
  filterRef.current = filter;

  const fetchPage = useCallback(
    async (opts: { append: boolean; before?: string }) => {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      if (filterRef.current === "unread") params.set("unread", "1");
      if (filterRef.current === "archived") params.set("includeArchived", "1");
      if (opts.before) params.set("before", opts.before);
      const res = await fetch(`/api/whatsapp/conversations?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        ok: boolean;
        conversations: ConversationDTO[];
        nextBefore: string | null;
      };
      const filtered =
        filterRef.current === "archived"
          ? json.conversations.filter((c) => !!c.archivedAt)
          : json.conversations.filter((c) =>
              filterRef.current === "unread" ? c.unreadCount > 0 : !c.archivedAt,
            );
      setItems((prev) => {
        if (!opts.append) return filtered;
        const seen = new Set(prev.map((p) => p.id));
        return prev.concat(filtered.filter((c) => !seen.has(c.id)));
      });
      setNextBefore(json.nextBefore);
    },
    [],
  );

  useEffect(() => {
    setLoading(true);
    setError(null);
    setItems([]);
    setNextBefore(null);
    fetchPage({ append: false })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [filter, fetchPage, refreshSignal]);

  useEffect(() => {
    const handle = setInterval(() => {
      fetchPage({ append: false }).catch(() => {
        // ignore — UI keeps showing the last good list
      });
    }, POLL_MS);
    return () => clearInterval(handle);
  }, [fetchPage]);

  const handleLoadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      await fetchPage({ append: true, before: nextBefore });
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-white border border-border rounded-xl overflow-hidden">
      {/* Tabs */}
      <div className="flex items-center border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setFilter(tab.value)}
            className={cn(
              "flex-1 py-2.5 text-sm font-medium transition-colors",
              filter === tab.value
                ? "text-accent border-b-2 border-accent"
                : "text-text-secondary hover:text-text-primary",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-sm text-text-secondary text-center">
            {t.list.loading}
          </div>
        ) : error ? (
          <div className="p-4 text-sm text-error text-center">
            {t.list.errorPrefix} {error}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-6 text-text-secondary">
            <MessageCircle className="w-10 h-10 mb-2 opacity-40" />
            <p className="text-sm">
              {filter === "unread"
                ? t.list.emptyUnread
                : filter === "archived"
                  ? t.list.emptyArchived
                  : t.list.emptyAll}
            </p>
          </div>
        ) : (
          <ul>
            {items.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  className={cn(
                    "w-full text-start px-3 py-2.5 border-b border-border hover:bg-bg-main transition-colors",
                    activeId === c.id && "bg-accent-light/40",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate" dir="auto">
                          {c.displayName || c.phoneNumber}
                        </span>
                        {c.unreadCount > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent text-white tabular-nums">
                            {c.unreadCount}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-text-secondary truncate mt-0.5" dir="auto">
                        {c.lastMessageDirection === "outbound" && (
                          <span className="text-text-secondary/70">
                            {t.list.youPrefix}
                          </span>
                        )}
                        {c.lastMessagePreview || "—"}
                      </p>
                    </div>
                    <span className="text-[10px] text-text-secondary shrink-0">
                      {relativeTime(c.lastMessageAt, locale, t.relative)}
                    </span>
                  </div>
                </button>
              </li>
            ))}
            {nextBefore && (
              <li className="p-3 text-center">
                <button
                  type="button"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="text-xs text-accent hover:underline disabled:opacity-50"
                >
                  {loadingMore ? t.list.loadingMore : t.list.loadMore}
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
