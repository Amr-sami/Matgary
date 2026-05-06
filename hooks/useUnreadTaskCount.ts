"use client";

import { useCallback, useEffect, useState } from "react";

const POLL_INTERVAL_MS = 60_000;

export function useUnreadTaskCount() {
  const [count, setCount] = useState(0);

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
    refresh();
    const t = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  return { count, refresh };
}
