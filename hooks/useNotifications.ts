"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDeferred } from "./useDeferred";

export type NotificationKind =
  | "low_stock"
  | "task_assigned"
  | "task_started"
  | "task_done"
  | "task_updated"
  | "leave_submitted"
  | "leave_decided"
  | "info";

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  createdAt: Date;
}

interface ApiNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  createdAt: string;
}

interface StreamPayload {
  data: ApiNotification[];
  unread: number;
}

// SSE is the preferred path: a single long-lived connection that the server
// pushes onto whenever a notification mutation lands. The client used to do
// a 60 s setInterval which woke the radio every minute on phones — SSE
// piggybacks on the existing TCP keepalive so the per-minute wake-up goes
// away entirely.
//
// Polling is the explicit fallback for two cases:
//   - The browser doesn't ship EventSource (none of our supported targets,
//     but defensive).
//   - The SSE handshake fails repeatedly (e.g. an enterprise proxy strips
//     `text/event-stream`). After two consecutive errors we stop reconnecting
//     and switch to a slower polling loop so the bell still works.
const POLL_INTERVAL_MS = 60_000;
const SSE_ERROR_BACKOFF_LIMIT = 2;

function applyPayload(
  payload: StreamPayload,
  setItems: (v: NotificationItem[]) => void,
  setUnread: (v: number) => void,
) {
  setItems(
    payload.data.map((n) => ({ ...n, createdAt: new Date(n.createdAt) })),
  );
  setUnread(payload.unread);
}

export function useNotifications() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  // `errorCount` is held in a ref so it can outlive transient EventSource
  // close-and-reopen cycles without re-rendering.
  const errorCountRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (res.status === 401) {
        setItems([]);
        setUnread(0);
        return;
      }
      if (!res.ok) return;
      const json = (await res.json()) as StreamPayload;
      applyPayload(json, setItems, setUnread);
    } finally {
      setLoading(false);
    }
  }, []);

  // Defer the SSE handshake out of the critical first-paint window via
  // useDeferred (idle / first interaction / 2 s fallback). The bell only
  // matters AFTER the user is looking — opening a long-lived TCP
  // connection during hydration adds mobile CPU + radio cost to the
  // moment that already has the most.
  const armed = useDeferred(2000);

  useEffect(() => {
    if (!armed || typeof window === "undefined") return;
    setLoading(true);

    let pollHandle: ReturnType<typeof setInterval> | null = null;
    let source: EventSource | null = null;

    const startPolling = () => {
      if (pollHandle) return;
      void refresh();
      pollHandle = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    };

    const startSSE = () => {
      if (typeof EventSource === "undefined") {
        startPolling();
        return;
      }
      try {
        source = new EventSource("/api/notifications/stream");
      } catch {
        startPolling();
        return;
      }
      source.onmessage = (ev) => {
        errorCountRef.current = 0;
        try {
          const payload = JSON.parse(ev.data) as StreamPayload;
          applyPayload(payload, setItems, setUnread);
        } catch {
          // ignore malformed event
        } finally {
          setLoading(false);
        }
      };
      source.onerror = () => {
        // EventSource auto-reconnects, but if it keeps failing we give up
        // and fall back to polling so the bell still updates.
        errorCountRef.current += 1;
        if (errorCountRef.current >= SSE_ERROR_BACKOFF_LIMIT) {
          source?.close();
          source = null;
          startPolling();
        }
      };
    };

    startSSE();

    return () => {
      source?.close();
      if (pollHandle) clearInterval(pollHandle);
    };
  }, [armed, refresh]);

  const markRead = useCallback(async (id: string) => {
    // Optimistic — server-side publish will reconcile via SSE moments later.
    setItems((curr) =>
      curr.map((n) => (n.id === id ? { ...n, isRead: true } : n)),
    );
    setUnread((c) => Math.max(0, c - 1));
    await fetch(`/api/notifications/${id}/read`, { method: "POST" });
  }, []);

  const markAllRead = useCallback(async () => {
    setItems((curr) => curr.map((n) => ({ ...n, isRead: true })));
    setUnread(0);
    await fetch("/api/notifications/read-all", { method: "POST" });
  }, []);

  return { items, unread, loading, refresh, markRead, markAllRead };
}
