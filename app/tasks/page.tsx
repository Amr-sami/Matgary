"use client";

import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { TasksTab } from "@/components/tasks/TasksTab";
import { Toast } from "@/components/ui/Toast";
import { useUnreadTaskCount } from "@/hooks/useUnreadTaskCount";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

type ToastState = { type: "success" | "error"; message: string } | null;

export default function TasksPage() {
  const dict = useDictionary();
  const t = dict.app.tasks.page;
  const [toast, setToast] = useState<ToastState>(null);
  const { refresh: refreshUnread } = useUnreadTaskCount();

  return (
    <AppShell title={t.title}>
      <div className="max-w-5xl mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-bold text-text-primary leading-tight">
            {t.heading}
          </h1>
          <p className="text-sm text-text-secondary mt-0.5">
            {t.subhead}
          </p>
        </header>

        <TasksTab onToast={setToast} onUnreadChange={refreshUnread} />
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
