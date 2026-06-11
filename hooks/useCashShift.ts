"use client";

import { useCallback, useEffect, useState } from "react";

export interface CashShiftSummary {
  id: string;
  branchId: string;
  branchName: string | null;
  cashierUserId: string;
  cashierName: string | null;
  status: "open" | "closed" | "reviewed";
  openedAt: string;
  openingFloat: string;
  openingNote: string | null;
  closedAt: string | null;
  expectedCash: string | null;
  countedCash: string | null;
  variance: string | null;
}

interface CurrentResponse {
  shift: CashShiftSummary | null;
}

// 30s poll matches the drawer-panel cadence: any cash sale rung up by a
// colleague reflects in the expected within half a minute, and the chip
// in the topbar stays roughly live without DB hammering.
const POLL_MS = 30_000;

/** Polls /api/cash-shifts/current. Returns null when no open shift, or
 *  the call 401s/403s (non-cashier users). */
export function useCashShift() {
  const [shift, setShift] = useState<CashShiftSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/cash-shifts/current", {
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) {
        setShift(null);
        return;
      }
      if (!res.ok) return;
      const json: CurrentResponse = await res.json();
      setShift(json.shift);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { shift, loading, refresh };
}
