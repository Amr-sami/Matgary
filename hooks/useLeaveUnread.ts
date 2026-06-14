"use client";

import { useCallback, useEffect, useState } from "react";
import { useDeferred } from "./useDeferred";

const POLL_INTERVAL_MS = 60_000;

export interface LeaveUnread {
  /** New leave requests submitted by staff that the manager hasn't seen. */
  submitted: number;
  /** Decisions on requests the current user submitted that they haven't seen. */
  decided: number;
}

const EMPTY: LeaveUnread = { submitted: 0, decided: 0 };

export function useLeaveUnread() {
  const [counts, setCounts] = useState<LeaveUnread>(EMPTY);
  // Defer the first poll out of the critical mount window. Three
  // components consume this hook (Sidebar, /team page, LeaveTab); each
  // mount otherwise fires the poll inside the same hydration burst.
  const armed = useDeferred(2000);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/leave-requests/unread-summary", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const json: LeaveUnread = await res.json();
      setCounts(json);
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    if (!armed) return;
    refresh();
    const t = setInterval(refresh, POLL_INTERVAL_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [armed, refresh]);

  return { counts, refresh };
}
