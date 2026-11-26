"use client";

import { useCallback, useEffect, useState } from "react";

export type LeaveStatus = "pending" | "approved" | "rejected";

export interface LeaveRequestItem {
  id: string;
  userId: string;
  userName: string | null;
  startDate: Date;
  endDate: Date;
  reason: string | null;
  status: LeaveStatus;
  decidedByUserId: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
}

interface ApiLeave extends Omit<
  LeaveRequestItem,
  "startDate" | "endDate" | "decidedAt" | "createdAt"
> {
  startDate: string;
  endDate: string;
  decidedAt: string | null;
  createdAt: string;
}

const fromApi = (l: ApiLeave): LeaveRequestItem => ({
  ...l,
  startDate: new Date(l.startDate),
  endDate: new Date(l.endDate),
  decidedAt: l.decidedAt ? new Date(l.decidedAt) : null,
  createdAt: new Date(l.createdAt),
});

export function useLeaveRequests() {
  const [data, setData] = useState<LeaveRequestItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/leave-requests", { cache: "no-store" });
      if (res.status === 401 || res.status === 403) {
        setData([]);
        return;
      }
      if (!res.ok) return;
      const json: { data: ApiLeave[] } = await res.json();
      setData(json.data.map(fromApi));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, refresh };
}
