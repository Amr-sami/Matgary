"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { TeamEditor } from "@/components/settings/TeamEditor";
import { CompensationEditor } from "@/components/team/CompensationEditor";
import { AttendanceSettingsEditor } from "@/components/team/AttendanceSettingsEditor";
import { AttendanceRoster } from "@/components/team/AttendanceRoster";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { Toast } from "@/components/ui/Toast";

type ToastState = { type: "success" | "error"; message: string } | null;
type TabKey = "team" | "attendance" | "payroll" | "settings";

const TAB_DESCRIPTIONS: Record<TabKey, string> = {
  team: "أضف موظفين، حدّد صلاحياتهم، وأدر بياناتهم وصورهم.",
  attendance: "تابع تسجيل دخول وخروج الموظفين خلال اليوم.",
  payroll: "إدارة الرواتب الثابتة، المعدلات الساعية، والاستحقاقات.",
  settings: "ساعات العمل، أيام الإجازة، نسبة الأوفر، ومواقع المتجر.",
};

export default function TeamPage() {
  return (
    <Suspense fallback={null}>
      <TeamPageInner />
    </Suspense>
  );
}

function TeamPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTab = (searchParams.get("tab") as TabKey | null) ?? "team";

  const [toast, setToast] = useState<ToastState>(null);
  const [tab, setTab] = useState<TabKey>(initialTab);

  useEffect(() => {
    const next = (searchParams.get("tab") as TabKey | null) ?? "team";
    if (next !== tab) setTab(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const changeTab = (next: TabKey) => {
    setTab(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next === "team") params.delete("tab");
    else params.set("tab", next);
    const qs = params.toString();
    router.replace(qs ? `/team?${qs}` : "/team", { scroll: false });
  };

  const tabs: TabItem<TabKey>[] = [
    { key: "team", label: "الفريق والصلاحيات" },
    { key: "attendance", label: "الحضور" },
    { key: "payroll", label: "الرواتب" },
    { key: "settings", label: "إعدادات الحضور" },
  ];

  return (
    <AppShell title="الموظفون">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Page header */}
        <header>
          <h1 className="text-2xl font-bold text-text-primary leading-tight">الفريق</h1>
          <p className="text-sm text-text-secondary mt-0.5">{TAB_DESCRIPTIONS[tab]}</p>
        </header>

        <Tabs items={tabs} active={tab} onChange={changeTab} />

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
