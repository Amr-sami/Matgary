"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { AppShell } from "@/components/layout/AppShell";
import { TeamEditor } from "@/components/settings/TeamEditor";
import { CompensationEditor } from "@/components/team/CompensationEditor";
import { AttendanceSettingsEditor } from "@/components/team/AttendanceSettingsEditor";
import { AttendanceRoster } from "@/components/team/AttendanceRoster";
import { LeaveTab } from "@/components/leave/LeaveTab";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { Toast } from "@/components/ui/Toast";
import { can } from "@/lib/permissions";
import { useLeaveUnread } from "@/hooks/useLeaveUnread";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

type ToastState = { type: "success" | "error"; message: string } | null;
type TabKey = "team" | "attendance" | "payroll" | "leaves" | "settings";

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
  const dict = useDictionary();
  const t = dict.app.team;
  const { data: session } = useSession();
  const principal = session?.user
    ? { role: session.user.role, permissions: session.user.permissions }
    : null;
  const isManager = can(principal, "manage_team");
  const canSeeLeaves =
    can(principal, "manage_leave") || can(principal, "request_leave");
  const { refresh: refreshLeaveUnread } = useLeaveUnread();

  // Tab list adapts to perms. Staff with only request_leave see only "leaves";
  // managers see the full set. Default tab is the first allowed.
  const tabs = useMemo<TabItem<TabKey>[]>(() => {
    const items: TabItem<TabKey>[] = [];
    if (isManager) items.push({ key: "team", label: t.tabs.team });
    if (isManager) items.push({ key: "attendance", label: t.tabs.attendance });
    if (isManager) items.push({ key: "payroll", label: t.tabs.payroll });
    if (canSeeLeaves) items.push({ key: "leaves", label: t.tabs.leaves });
    if (isManager) items.push({ key: "settings", label: t.tabs.settings });
    return items;
  }, [isManager, canSeeLeaves, t.tabs]);

  const defaultTab: TabKey = useMemo(
    () => tabs[0]?.key ?? "team",
    [tabs],
  );

  const requestedTab = (searchParams.get("tab") as TabKey | null) ?? null;
  const initialTab: TabKey =
    requestedTab && tabs.some((tab) => tab.key === requestedTab)
      ? requestedTab
      : defaultTab;

  const [toast, setToast] = useState<ToastState>(null);
  const [tab, setTab] = useState<TabKey>(initialTab);

  useEffect(() => {
    const requested = searchParams.get("tab") as TabKey | null;
    const next =
      requested && tabs.some((tabItem) => tabItem.key === requested)
        ? requested
        : defaultTab;
    if (next !== tab) setTab(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, tabs]);

  const changeTab = (next: TabKey) => {
    setTab(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next === defaultTab) params.delete("tab");
    else params.set("tab", next);
    const qs = params.toString();
    router.replace(qs ? `/team?${qs}` : "/team", { scroll: false });
  };

  const pageTitle = isManager ? t.heading.manager : t.heading.staff;
  const shellTitle = isManager ? t.pageTitle.manager : t.pageTitle.staff;

  return (
    <AppShell title={shellTitle}>
      <div className="max-w-5xl mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-bold text-text-primary leading-tight">
            {pageTitle}
          </h1>
          <p className="text-sm text-text-secondary mt-0.5">
            {t.tabDescriptions[tab]}
          </p>
        </header>

        {tabs.length > 1 && (
          <Tabs items={tabs} active={tab} onChange={changeTab} />
        )}

        {tab === "team" && isManager && <TeamEditor onToast={setToast} />}
        {tab === "attendance" && isManager && (
          <AttendanceRoster onToast={setToast} />
        )}
        {tab === "payroll" && isManager && (
          <CompensationEditor onToast={setToast} />
        )}
        {tab === "leaves" && canSeeLeaves && (
          <LeaveTab onToast={setToast} onUnreadChange={refreshLeaveUnread} />
        )}
        {tab === "settings" && isManager && (
          <AttendanceSettingsEditor onToast={setToast} />
        )}
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
