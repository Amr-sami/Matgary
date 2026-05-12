"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ChevronRight, Send, MessageCircle } from "@/lib/icons";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { MessageBubble } from "./MessageBubble";
import { windowDisplay } from "./format";
import type { ConversationDetailDTO, MessageDTO } from "./types";

interface Props {
  conversationId: string;
  /** Closes the thread on mobile (returns to the list pane). */
  onBack: () => void;
  /** Called after a successful action that should re-poll the list. */
  onChanged: () => void;
  onError: (msg: string) => void;
}

export interface ThreadViewHandle {
  /** Imperative refresh — used by the parent's poll loop. */
  refresh: () => void;
}

const POLL_MS = 8_000;
const PAGE_SIZE = 50;

export const ThreadView = forwardRef<ThreadViewHandle, Props>(
  function ThreadView({ conversationId, onBack, onChanged, onError }, ref) {
    const [conversation, setConversation] = useState<ConversationDetailDTO | null>(
      null,
    );
    const [messages, setMessages] = useState<MessageDTO[]>([]);
    const [olderCursor, setOlderCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [draft, setDraft] = useState("");
    const [sending, setSending] = useState(false);
    const [archiving, setArchiving] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement | null>(null);
    const initialLoadRef = useRef(true);

    const loadConversation = useCallback(async () => {
      const res = await fetch(`/api/whatsapp/conversations/${conversationId}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = (await res.json()) as { conversation: ConversationDetailDTO };
      setConversation(json.conversation);
    }, [conversationId]);

    const loadMessages = useCallback(
      async (opts: { before?: string; append?: boolean }) => {
        const params = new URLSearchParams();
        params.set("limit", String(PAGE_SIZE));
        if (opts.before) params.set("before", opts.before);
        const res = await fetch(
          `/api/whatsapp/conversations/${conversationId}/messages?${params}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          messages: MessageDTO[];
          nextBefore: string | null;
        };
        // API returns newest-first (created_at DESC). Render chronological,
        // so reverse for display.
        const chrono = [...json.messages].reverse();
        setMessages((prev) => {
          if (opts.append) {
            // Older page: prepend, deduping by id.
            const seen = new Set(prev.map((m) => m.id));
            return chrono.filter((m) => !seen.has(m.id)).concat(prev);
          }
          return chrono;
        });
        if (!opts.append) setOlderCursor(json.nextBefore);
      },
      [conversationId],
    );

    // Initial load + reset when conversation changes.
    useEffect(() => {
      setLoading(true);
      setMessages([]);
      setOlderCursor(null);
      initialLoadRef.current = true;
      Promise.all([loadConversation(), loadMessages({})])
        .catch((e) => onError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    }, [conversationId, loadConversation, loadMessages, onError]);

    // Auto-mark-read once on open. Fire and forget — failure is harmless.
    useEffect(() => {
      void fetch(`/api/whatsapp/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ read: true }),
      })
        .then(() => onChanged())
        .catch(() => {
          // ignore
        });
    }, [conversationId, onChanged]);

    // Poll thread for inbound messages + status updates.
    useEffect(() => {
      const handle = setInterval(() => {
        // Refresh latest page (newest); the older-cursor pagination
        // stays untouched. Conversation summary too so the window
        // countdown is fresh.
        void loadConversation();
        void loadMessages({}).catch(() => {
          // swallow — UI keeps showing the last good page
        });
      }, POLL_MS);
      return () => clearInterval(handle);
    }, [loadConversation, loadMessages]);

    // Imperative refresh for the parent.
    useImperativeHandle(
      ref,
      () => ({
        refresh: () => {
          void loadConversation();
          void loadMessages({}).catch(() => {});
        },
      }),
      [loadConversation, loadMessages],
    );

    // Scroll to bottom when the message count grows (new outbound or
    // inbound), but not when older history is prepended.
    useEffect(() => {
      if (!messages.length) return;
      if (initialLoadRef.current) {
        initialLoadRef.current = false;
        messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
        return;
      }
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages.length]);

    const handleLoadOlder = async () => {
      if (!olderCursor || loadingOlder) return;
      setLoadingOlder(true);
      try {
        await loadMessages({ before: olderCursor, append: true });
        // After appending older, also fetch a fresh nextBefore from the
        // first message we just got.
        // (The API returned its own nextBefore; we just trust that.)
      } finally {
        setLoadingOlder(false);
      }
    };

    const canSendFreeform = !!conversation?.windowOpen;

    const handleSend = async () => {
      const text = draft.trim();
      if (!text || !conversation) return;
      if (!canSendFreeform) {
        onError("نافذة الـ 24 ساعة مغلقة. استخدم قالباً معتمداً.");
        return;
      }
      setSending(true);
      try {
        const res = await fetch("/api/whatsapp/cloud/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone: conversation.phoneNumber,
            message: text,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) {
          onError(json?.error || `HTTP ${res.status}`);
          return;
        }
        setDraft("");
        // Refresh both panes immediately so the user sees the queued
        // message instead of waiting for the 8s tick.
        void loadMessages({});
        void loadConversation();
        onChanged();
      } finally {
        setSending(false);
      }
    };

    const handleToggleArchive = async () => {
      if (!conversation) return;
      setArchiving(true);
      try {
        const res = await fetch(
          `/api/whatsapp/conversations/${conversation.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archived: !conversation.archivedAt }),
          },
        );
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          onError(j?.error || `HTTP ${res.status}`);
          return;
        }
        void loadConversation();
        onChanged();
      } finally {
        setArchiving(false);
      }
    };

    if (loading || !conversation) {
      return (
        <div className="flex flex-col h-full bg-white border border-border rounded-xl items-center justify-center text-text-secondary">
          جارٍ التحميل...
        </div>
      );
    }

    const w = windowDisplay(conversation.windowExpiresAt);

    return (
      <div className="flex flex-col h-full bg-white border border-border rounded-xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-3 py-2.5 border-b border-border">
          {/* Mobile back button — ChevronRight is the RTL "back". */}
          <button
            type="button"
            onClick={onBack}
            className="md:hidden p-1 rounded hover:bg-bg-main"
            aria-label="رجوع"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
          <div className="flex-1 min-w-0">
            <p className="font-medium truncate">
              {conversation.displayName || conversation.phoneNumber}
            </p>
            <p
              className="text-xs text-text-secondary truncate"
              dir="ltr"
            >
              +{conversation.phoneNumber}
            </p>
          </div>
          <button
            type="button"
            onClick={handleToggleArchive}
            disabled={archiving}
            className="text-xs text-text-secondary hover:text-accent px-2 py-1 rounded disabled:opacity-50"
          >
            {conversation.archivedAt ? "استعادة" : "أرشفة"}
          </button>
        </div>

        {/* Window state */}
        <div
          className={cn(
            "px-3 py-1.5 text-[11px] border-b border-border",
            w.tone === "open"
              ? "bg-success/10 text-success"
              : w.tone === "warning"
                ? "bg-orange-50 text-orange-700"
                : "bg-bg-main text-text-secondary",
          )}
        >
          {w.label}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
          {olderCursor && (
            <div className="text-center">
              <button
                type="button"
                onClick={handleLoadOlder}
                disabled={loadingOlder}
                className="text-xs text-accent hover:underline disabled:opacity-50"
              >
                {loadingOlder ? "..." : "تحميل أقدم"}
              </button>
            </div>
          )}
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center text-text-secondary">
              <MessageCircle className="w-8 h-8 mb-2 opacity-40" />
              <p className="text-sm">لا توجد رسائل بعد.</p>
            </div>
          ) : (
            messages.map((m) => <MessageBubble key={m.id} message={m} />)
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Composer */}
        <div className="border-t border-border p-2">
          {canSendFreeform ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSend();
              }}
              className="flex items-end gap-2"
            >
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                rows={1}
                placeholder="اكتب رسالة..."
                dir="rtl"
                className="flex-1 resize-none rounded-lg border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent max-h-32"
              />
              <Button
                type="submit"
                size="sm"
                loading={sending}
                disabled={!draft.trim() || sending}
              >
                <Send className="w-4 h-4 me-1" />
                إرسال
              </Button>
            </form>
          ) : (
            <div className="text-xs text-text-secondary text-center py-2 leading-relaxed">
              لا يمكن إرسال رسائل حرّة الآن — استخدم قالباً معتمداً.{" "}
              <a
                href="/settings"
                className="text-accent hover:underline"
              >
                إدارة القوالب
              </a>
            </div>
          )}
        </div>
      </div>
    );
  },
);
