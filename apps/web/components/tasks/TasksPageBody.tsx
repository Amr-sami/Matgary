"use client";

// Client island for /tasks. Owns the toast state + wires the badge
// invalidation into TasksTab. Everything that needs state or hooks
// lives here so the page can stay a Server Component.

import { useState } from "react";
import { TasksTab } from "./TasksTab";
import { Toast } from "../ui/Toast";
import { useUnreadTaskCount } from "@/hooks/useUnreadTaskCount";

type ToastState = { type: "success" | "error"; message: string } | null;

export function TasksPageBody() {
  const [toast, setToast] = useState<ToastState>(null);
  const { refresh: refreshUnread } = useUnreadTaskCount();
  return (
    <>
      <TasksTab onToast={setToast} onUnreadChange={refreshUnread} />
      {toast && (
        <Toast
          type={toast.type}
          message={toast.message}
          onClose={() => setToast(null)}
        />
      )}
    </>
  );
}
