// /team — Server Component.
//
// Resolves dictionary + session + permissions on the server, picks the
// active tab from `?tab=`, and delegates to the TeamPageBody client
// island. The island still owns tab switching (router.replace) +
// useLeaveUnread polling + toast.
//
// Net SC win is small — the page itself is wrapper logic, the 5 tab
// bodies are large client components that must stay client. Documented
// here because the user explicitly approved this conversion.

import { Suspense } from "react";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/layout/AppShell";
import { TeamPageBody } from "@/components/team/TeamPageBody";
import { can } from "@/lib/permissions";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { defaultLocale, isLocale } from "@/lib/i18n/config";

type TabKey = "team" | "attendance" | "payroll" | "leaves" | "settings";

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const [hdrs, session, sp] = await Promise.all([
    headers(),
    auth(),
    searchParams,
  ]);
  const raw = hdrs.get("x-locale");
  const locale = raw && isLocale(raw) ? raw : defaultLocale;
  const dict = await getDictionary(locale);
  const t = dict.app.team;

  const principal = session?.user
    ? { role: session.user.role, permissions: session.user.permissions }
    : null;
  const isManager = can(principal, "manage_team");
  const canSeeLeaves =
    can(principal, "manage_leave") || can(principal, "request_leave");

  // Resolve initial tab on the server. The island still re-syncs on
  // searchParams change for back/forward navigation.
  const allowed: TabKey[] = [];
  if (isManager) allowed.push("team", "attendance", "payroll");
  if (canSeeLeaves) allowed.push("leaves");
  if (isManager) allowed.push("settings");
  const defaultTab: TabKey = allowed[0] ?? "team";
  const requested = sp.tab as TabKey | undefined;
  const initialTab: TabKey =
    requested && allowed.includes(requested) ? requested : defaultTab;

  const pageTitle = isManager ? t.heading.manager : t.heading.staff;
  const shellTitle = isManager ? t.pageTitle.manager : t.pageTitle.staff;

  return (
    <AppShell title={shellTitle}>
      <div className="max-w-5xl mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-bold text-text-primary leading-tight">
            {pageTitle}
          </h1>
        </header>

        <Suspense fallback={null}>
          <TeamPageBody
            isManager={isManager}
            canSeeLeaves={canSeeLeaves}
            initialTab={initialTab}
            strings={{
              tabs: {
                team: t.tabs.team,
                attendance: t.tabs.attendance,
                payroll: t.tabs.payroll,
                leaves: t.tabs.leaves,
                settings: t.tabs.settings,
              },
              tabDescriptions: t.tabDescriptions,
            }}
          />
        </Suspense>
      </div>
    </AppShell>
  );
}
