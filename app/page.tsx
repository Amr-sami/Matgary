// Dashboard — Server Component.
//
// Architecture per PHASE3.md / PERFORMANCE_BASELINE.md §3 item 1:
//   • Page body resolves session + active branch + dictionary at the SC layer.
//   • Three data widgets (Stats, LowStockAlert, RecentSales) become async
//     Server Components and stream behind <Suspense> — the dashboard
//     skeleton paints first, then each widget swaps in as its query resolves.
//   • Interactive leaves stay as Client Components (Greeting, SelfCheckIn,
//     BroadcastStack, AppShell chrome).
//
// What's NOT here:
//   • No `"use client"` at the page level.
//   • No `useEffect` for data fetching.
//   • No mount-fetch waterfall — Promise.all inside each SC widget.

import { Suspense } from "react";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { Greeting } from "@/components/dashboard/Greeting";
import { SelfCheckIn } from "@/components/team/SelfCheckIn";
import { BroadcastStack } from "@/components/broadcasts/BroadcastStack";
import {
  StatsGridServer,
  StatsGridSkeleton,
} from "@/components/dashboard/StatsGridServer";
import {
  LowStockAlertServer,
  LowStockAlertSkeleton,
} from "@/components/dashboard/LowStockAlertServer";
import {
  RecentSalesListServer,
  RecentSalesListSkeleton,
} from "@/components/dashboard/RecentSalesListServer";
import { resolveActiveBranch } from "@/lib/api/branch-context";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { defaultLocale, isLocale } from "@/lib/i18n/config";

export default async function DashboardPage() {
  // Auth gate. Middleware redirects unauthenticated requests to /login
  // already, but a stale cookie or onboarding-incomplete tenant lands here
  // — bounce to the right place rather than crashing the page.
  const session = await auth();
  if (!session?.user?.tenantId) {
    redirect("/ar/login");
  }
  const userId = session.user.id;
  const tenantId = session.user.tenantId;

  // Active branch (HttpOnly cookie + allow-list resolution). Mirrors what
  // every API route does — the SC widgets receive a stable branchId.
  const branch = await resolveActiveBranch({
    userId,
    tenantId,
    role: session.user.role,
  });
  const branchId = branch?.branchId ?? null;

  // Locale + dictionary. Middleware stamps x-locale on every request — we
  // honour it so the dashboard renders in the user's chosen language even
  // before client hydration runs.
  const hdrs = await headers();
  const rawLocale = hdrs.get("x-locale");
  const locale = rawLocale && isLocale(rawLocale) ? rawLocale : defaultLocale;
  const dict = await getDictionary(locale);

  return (
    <AppShell title={dict.app.dashboard.title}>
      <div className="space-y-6">
        {/* Platform-admin Spec 06: system-wide banner stack. Dashboard-only
            so it doesn't follow the user into focus surfaces. */}
        <BroadcastStack />
        <Greeting />
        <SelfCheckIn />

        {/* Stats stream independently so the row paints as soon as its
            three repo reads resolve. */}
        <Suspense fallback={<StatsGridSkeleton />}>
          <StatsGridServer
            tenantId={tenantId}
            branchId={branchId}
            dict={dict}
            locale={locale}
          />
        </Suspense>

        {/* `items-start` so each tile sizes to its own content instead of
            the grid stretching the shorter card to match the taller one. */}
        <div className="grid md:grid-cols-2 gap-6 items-start">
          <Suspense fallback={<LowStockAlertSkeleton />}>
            <LowStockAlertServer
              tenantId={tenantId}
              branchId={branchId}
              dict={dict}
            />
          </Suspense>
          <Suspense fallback={<RecentSalesListSkeleton />}>
            <RecentSalesListServer
              tenantId={tenantId}
              branchId={branchId}
              dict={dict}
              locale={locale}
            />
          </Suspense>
        </div>
      </div>
    </AppShell>
  );
}
