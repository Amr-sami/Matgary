"use client";

import { useQuery } from "@tanstack/react-query";
import { useDeferred } from "./useDeferred";

const POLL_INTERVAL_MS = 60_000;
const QUERY_KEY = ["leave-unread-summary"] as const;

export interface LeaveUnread {
  /** New leave requests submitted by staff that the manager hasn't seen. */
  submitted: number;
  /** Decisions on requests the current user submitted that they haven't seen. */
  decided: number;
}

const EMPTY: LeaveUnread = { submitted: 0, decided: 0 };

async function fetchLeaveUnread(): Promise<LeaveUnread> {
  const res = await fetch("/api/leave-requests/unread-summary", { cache: "no-store" });
  if (!res.ok) return EMPTY;
  return (await res.json()) as LeaveUnread;
}

export function useLeaveUnread() {
  // Deferred for the same reason as useUnreadTaskCount; TanStack Query
  // then dedupes the poll across all 3 consumers (Sidebar, /team page,
  // LeaveTab).
  const armed = useDeferred(2000);

  const query = useQuery<LeaveUnread>({
    queryKey: QUERY_KEY,
    queryFn: fetchLeaveUnread,
    enabled: armed,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    // Tab focus refetch is the one extra source of freshness the old
    // hook had — opt in here (default global is `false`).
    refetchOnWindowFocus: true,
    staleTime: POLL_INTERVAL_MS / 2,
    gcTime: 5 * 60_000,
  });

  return { counts: query.data ?? EMPTY, refresh: query.refetch };
}
