"use client";

import { useState } from "react";
import { UsersGroup } from "@/lib/icons";
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

const TAB_DESCRIPTIONS: Record<TabKey, string> = {
  team: "أضف موظفين، حدّد صلاحياتهم، وأدر بياناتهم وصورهم.",
  attendance: "تابع تسجيل دخول وخروج الموظفين خلال اليوم.",
  payroll: "إدارة الرواتب الثابتة، المعدلات الساعية، والاستحقاقات.",
  settings: "ساعات العمل، أيام الإجازة، نسبة الأوفر، ومواقع المتجر.",
};

export default function TeamPage() {
  const [toast, setToast] = useState<ToastState>(null);
  const [tab, setTab] = useState<TabKey>("team");

  return (
    <AppShell title="الموظفون">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Page header */}
        <header className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-accent-light text-accent flex items-center justify-center shrink-0">
            <UsersGroup className="w-6 h-6" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-text-primary leading-tight">الفريق</h1>
            <p className="text-sm text-text-secondary mt-0.5">{TAB_DESCRIPTIONS[tab]}</p>
          </div>
        </header>

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
