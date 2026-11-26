"use client";

import { useQuery } from "@tanstack/react-query";
import { useDeferred } from "./useDeferred";

const POLL_INTERVAL_MS = 60_000;
const QUERY_KEY = ["unread-task-count"] as const;

async function fetchUnreadTaskCount(): Promise<number> {
  const res = await fetch("/api/tasks/unread-count", { cache: "no-store" });
  if (!res.ok) return 0;
  const json: { count: number } = await res.json();
  return json.count;
}

export function useUnreadTaskCount() {
  // Defer the first poll out of the critical mount window (Wave 1
  // pattern); TanStack Query then takes over and dedupes both the
  // initial fetch AND the polling timer across all 3 consumers
  // (Sidebar, /tasks page, NotificationBell).
  const armed = useDeferred(2000);

  const query = useQuery<number>({
    queryKey: QUERY_KEY,
    queryFn: fetchUnreadTaskCount,
    enabled: armed,
    refetchInterval: POLL_INTERVAL_MS,
    // Don't pause the poll when tab is hidden: badge count should be
    // current the instant the user looks at the page.
    refetchIntervalInBackground: false,
    staleTime: POLL_INTERVAL_MS / 2,
    gcTime: 5 * 60_000,
  });

  return { count: query.data ?? 0, refresh: query.refetch };
}
