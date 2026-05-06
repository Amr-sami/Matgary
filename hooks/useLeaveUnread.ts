"use client";

import { useCallback, useEffect, useState } from "react";

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
    refresh();
    const t = setInterval(refresh, POLL_INTERVAL_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { counts, refresh };
}
