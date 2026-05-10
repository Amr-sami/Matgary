"use client";

import { useCallback, useEffect, useState } from "react";
import { counts, drainOutbox } from "@/lib/offline/outbox";
import type { OutboxStatus } from "@/lib/offline/db";

// Single source of truth for the topbar offline indicator and any other
// component that needs to show "X sales waiting to sync" or react to
// connectivity changes.
//
// Triggers a drain on:
//   - mount,
//   - the browser `online` event,
//   - tab focus / visibility change (covers the case where the laptop
//     was suspended during the outage),
//   - a slow polling tick (every 30s) as belt-and-braces.

const SYNC_POLL_MS = 30_000;
const REFRESH_POLL_MS = 5_000;

function snapshot(): { online: boolean } {
  return {
    online: typeof navigator === "undefined" ? true : navigator.onLine,
  };
}

export function useOffline() {
  const [online, setOnline] = useState<boolean>(snapshot().online);
  const [outboxCounts, setCounts] = useState<Record<OutboxStatus, number>>({
    pending: 0,
    syncing: 0,
    synced: 0,
    failed: 0,
  });
  const [syncing, setSyncing] = useState(false);

  const refreshCounts = useCallback(async () => {
    try {
      const c = await counts();
      setCounts(c);
    } catch {
      // IndexedDB unavailable (private mode in some browsers, etc.) —
      // leave counts at zero and don't blow up.
    }
  }, []);

  const sync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await drainOutbox();
      await refreshCounts();
    } finally {
      setSyncing(false);
    }
  }, [refreshCounts, syncing]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    void refreshCounts();
    void sync();

    const onOnline = () => {
      setOnline(true);
      void sync();
    };
    const onOffline = () => setOnline(false);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void sync();
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibility);

    const syncTick = setInterval(() => void sync(), SYNC_POLL_MS);
    const refreshTick = setInterval(() => void refreshCounts(), REFRESH_POLL_MS);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(syncTick);
      clearInterval(refreshTick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    online,
    syncing,
    counts: outboxCounts,
    /** Pending + syncing — what the badge should show. */
    queueDepth: outboxCounts.pending + outboxCounts.syncing,
    /** Failed rows — owner should see + acknowledge. */
    failedCount: outboxCounts.failed,
    /** Manually trigger a drain (used by the indicator's "retry now" button). */
    sync,
  };
}
