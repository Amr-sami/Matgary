"use client";

import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { TeamEditor } from "@/components/settings/TeamEditor";
import { CompensationEditor } from "@/components/team/CompensationEditor";
import { AttendanceSettingsEditor } from "@/components/team/AttendanceSettingsEditor";
import { AttendanceRoster } from "@/components/team/AttendanceRoster";
import { Tabs } from "@/components/ui/Tabs";
import { Toast } from "@/components/ui/Toast";

type ToastState = { type: "success" | "error"; message: string } | null;
type TabKey = "team" | "attendance" | "payroll" | "settings";

const TABS: { key: TabKey; label: string }[] = [
  { key: "team", label: "الفريق والصلاحيات" },
  { key: "attendance", label: "الحضور" },
  { key: "payroll", label: "الرواتب" },
  { key: "settings", label: "إعدادات الحضور" },
];

export default function TeamPage() {
  const [toast, setToast] = useState<ToastState>(null);
  const [tab, setTab] = useState<TabKey>("team");

  return (
    <AppShell title="الموظفون">
      <div className="max-w-3xl mx-auto space-y-4">
        <Tabs items={TABS} active={tab} onChange={setTab} />

        {tab === "team" && <TeamEditor onToast={setToast} />}
        {tab === "attendance" && <AttendanceRoster onToast={setToast} />}
        {tab === "payroll" && <CompensationEditor onToast={setToast} />}
        {tab === "settings" && <AttendanceSettingsEditor onToast={setToast} />}
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
