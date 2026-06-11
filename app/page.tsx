"use client";

import { AppShell } from "@/components/layout/AppShell";
import { StatsGrid } from "@/components/dashboard/StatsGrid";
import { LowStockAlert } from "@/components/dashboard/LowStockAlert";
import { RecentSalesList } from "@/components/dashboard/RecentSalesList";
import { Greeting } from "@/components/dashboard/Greeting";
import { SelfCheckIn } from "@/components/team/SelfCheckIn";
import { BroadcastStack } from "@/components/broadcasts/BroadcastStack";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

export default function DashboardPage() {
  const dict = useDictionary();
  return (
    <AppShell title={dict.app.dashboard.title}>
      <div className="space-y-6">
        {/* Platform-admin Spec 06: system-wide banner stack. Dashboard-only
            so it doesn't follow the user into focus surfaces (sales, POS,
            settings, etc). Self-hides when there's no broadcast for the
            caller's audience or every active broadcast was dismissed on
            this browser. */}
        <BroadcastStack />
        <Greeting />
        <SelfCheckIn />
        <StatsGrid />

        {/* `items-start` so each tile sizes to its own content instead of
            the grid stretching the shorter card to match the taller one
            — keeps LowStockAlert compact when there are only a few
            alerts (no empty white half) and lets the inner scroll only
            kick in when the list actually overflows. */}
        <div className="grid md:grid-cols-2 gap-6 items-start">
          <LowStockAlert />
          <RecentSalesList />
        </div>
      </div>
    </AppShell>
  );
}