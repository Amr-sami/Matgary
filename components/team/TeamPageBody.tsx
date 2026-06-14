"use client";

// Client island for /team. The page resolves session-derived
// permissions on the server and passes them as props, so this island
// never re-runs the auth check on the client.

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TeamEditor } from "../settings/TeamEditor";
import { CompensationEditor } from "./CompensationEditor";
import { AttendanceSettingsEditor } from "./AttendanceSettingsEditor";
import { AttendanceRoster } from "./AttendanceRoster";
import { LeaveTab } from "../leave/LeaveTab";
import { Tabs, type TabItem } from "../ui/Tabs";
import { Toast } from "../ui/Toast";
import { useLeaveUnread } from "@/hooks/useLeaveUnread";

type ToastState = { type: "success" | "error"; message: string } | null;
type TabKey = "team" | "attendance" | "payroll" | "leaves" | "settings";

export interface TeamPageBodyProps {
  isManager: boolean;
  canSeeLeaves: boolean;
  initialTab: TabKey;
  /** Localized strings, resolved on the server so the island doesn't
   *  pay the dictionary-subscription cost on hydration. */
  strings: {
    tabs: Record<TabKey, string>;
    tabDescriptions: Record<TabKey, string>;
  };
}

export function TeamPageBody({
  isManager,
  canSeeLeaves,
  initialTab,
  strings,
}: TeamPageBodyProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { counts: leaveUnread, refresh: refreshLeaveUnread } = useLeaveUnread();
  const leaveBadge = leaveUnread.submitted + leaveUnread.decided;

  const tabs = useMemo<TabItem<TabKey>[]>(() => {
    const items: TabItem<TabKey>[] = [];
    if (isManager) items.push({ key: "team", label: strings.tabs.team });
    if (isManager) items.push({ key: "attendance", label: strings.tabs.attendance });
    if (isManager) items.push({ key: "payroll", label: strings.tabs.payroll });
    if (canSeeLeaves) {
      items.push({
        key: "leaves",
        label: strings.tabs.leaves,
        badge: leaveBadge > 0 ? (leaveBadge > 99 ? "99+" : leaveBadge) : undefined,
      });
    }
    if (isManager) items.push({ key: "settings", label: strings.tabs.settings });
    return items;
  }, [isManager, canSeeLeaves, strings.tabs, leaveBadge]);

  const defaultTab: TabKey = useMemo(() => tabs[0]?.key ?? "team", [tabs]);

  const [toast, setToast] = useState<ToastState>(null);
  const [tab, setTab] = useState<TabKey>(initialTab);

  // Sync tab from URL on back/forward navigation.
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

  return (
    <>
      <p className="text-sm text-text-secondary mt-0.5">
        {strings.tabDescriptions[tab]}
      </p>
      {tabs.length > 1 && <Tabs items={tabs} active={tab} onChange={changeTab} />}

      {tab === "team" && isManager && <TeamEditor onToast={setToast} />}
      {tab === "attendance" && isManager && <AttendanceRoster onToast={setToast} />}
      {tab === "payroll" && isManager && <CompensationEditor onToast={setToast} />}
      {tab === "leaves" && canSeeLeaves && (
        <LeaveTab onToast={setToast} onUnreadChange={refreshLeaveUnread} />
      )}
      {tab === "settings" && isManager && (
        <AttendanceSettingsEditor onToast={setToast} />
      )}

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
