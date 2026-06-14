"use client";

import { useCallback, useEffect, useState } from "react";
import { useDeferred } from "./useDeferred";

const POLL_INTERVAL_MS = 60_000;

export function useUnreadTaskCount() {
  const [count, setCount] = useState(0);
  // Defer the first poll out of the critical mount window. Three
  // components consume this hook (Sidebar, /tasks page, NotificationBell);
  // without the defer each mount fires the poll inside the same
  // hydration burst the user is already waiting on.
  const armed = useDeferred(2000);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks/unread-count", { cache: "no-store" });
      if (!res.ok) return;
      const json: { count: number } = await res.json();
      setCount(json.count);
    } catch {
      // Quiet — badge fallback is "no badge".
    }
  }, []);

  useEffect(() => {
    if (!armed) return;
    refresh();
    const t = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [armed, refresh]);

  return { count, refresh };
}
