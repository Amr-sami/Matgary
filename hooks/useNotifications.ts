"use client";

import { useCallback, useEffect, useState } from "react";

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

const POLL_INTERVAL_MS = 60_000;

export function useNotifications() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (res.status === 401) {
        setItems([]);
        setUnread(0);
        return;
      }
      if (!res.ok) return;
      const json: { data: ApiNotification[]; unread: number } = await res.json();
      setItems(
        json.data.map((n) => ({ ...n, createdAt: new Date(n.createdAt) })),
      );
      setUnread(json.unread);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    refresh();
    const t = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const markRead = useCallback(
    async (id: string) => {
      // Optimistic
      setItems((curr) =>
        curr.map((n) => (n.id === id ? { ...n, isRead: true } : n)),
      );
      setUnread((c) => Math.max(0, c - 1));
      await fetch(`/api/notifications/${id}/read`, { method: "POST" });
    },
    [],
  );

  const markAllRead = useCallback(async () => {
    setItems((curr) => curr.map((n) => ({ ...n, isRead: true })));
    setUnread(0);
    await fetch("/api/notifications/read-all", { method: "POST" });
  }, []);

  return { items, unread, loading, refresh, markRead, markAllRead };
}
