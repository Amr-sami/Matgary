"use client";

import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { LeaveTab } from "@/components/leave/LeaveTab";
import { Toast } from "@/components/ui/Toast";
import { useLeaveUnread } from "@/hooks/useLeaveUnread";

type ToastState = { type: "success" | "error"; message: string } | null;

export default function LeavePage() {
  const [toast, setToast] = useState<ToastState>(null);
  const { refresh: refreshUnread } = useLeaveUnread();

  return (
    <AppShell title="الإجازات">
      <div className="max-w-5xl mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-bold text-text-primary leading-tight">
            الإجازات
          </h1>
          <p className="text-sm text-text-secondary mt-0.5">
            قدّم طلبات إجازتك وتابع حالة الموافقة عليها.
          </p>
        </header>

        <LeaveTab onToast={setToast} onUnreadChange={refreshUnread} />
      </div>

      {toast && (
        <Toast
          type={toast.type}
          message={toast.message}
          onClose={() => setToast(null)}
        />
      )}
    </AppShell>
  );
}
