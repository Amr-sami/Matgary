"use client";

import { useCallback, useEffect, useState } from "react";

export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";
export type TaskPriority = "low" | "normal" | "high";

export interface TaskItem {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: Date | null;
  completedAt: Date | null;
  assigneeSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  assignedToUserId: string | null;
  assignedToName: string | null;
  createdByUserId: string;
  createdByName: string | null;
}

interface ApiTask extends Omit<TaskItem, "dueDate" | "completedAt" | "assigneeSeenAt" | "createdAt" | "updatedAt"> {
  dueDate: string | null;
  completedAt: string | null;
  assigneeSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const fromApi = (t: ApiTask): TaskItem => ({
  ...t,
  dueDate: t.dueDate ? new Date(t.dueDate) : null,
  completedAt: t.completedAt ? new Date(t.completedAt) : null,
  assigneeSeenAt: t.assigneeSeenAt ? new Date(t.assigneeSeenAt) : null,
  createdAt: new Date(t.createdAt),
  updatedAt: new Date(t.updatedAt),
});

/**
 * Polls every 30s so an owner sees status changes the assignee makes (and
 * vice versa) without a manual refresh. Also re-runs when the tab regains
 * focus to feel snappy after the user comes back from another window.
 */
const POLL_INTERVAL_MS = 30_000;

export function useTasks() {
  const [data, setData] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks", { cache: "no-store" });
      if (res.status === 401 || res.status === 403) {
        setData([]);
        return;
      }
      if (!res.ok) return;
      const json: { data: ApiTask[] } = await res.json();
      setData(json.data.map(fromApi));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_INTERVAL_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { data, loading, refresh };
}
