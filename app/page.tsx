"use client";

import { AppShell } from "@/components/layout/AppShell";
import { StatsGrid } from "@/components/dashboard/StatsGrid";
import { LowStockAlert } from "@/components/dashboard/LowStockAlert";
import { RecentSalesList } from "@/components/dashboard/RecentSalesList";
import { Greeting } from "@/components/dashboard/Greeting";
import { SelfCheckIn } from "@/components/team/SelfCheckIn";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

export default function DashboardPage() {
  const dict = useDictionary();
  return (
    <AppShell title={dict.app.dashboard.title}>
      <div className="space-y-6">
        <Greeting />
        <SelfCheckIn />
        <StatsGrid />

        <div className="grid md:grid-cols-2 gap-6">
          <LowStockAlert />
          <RecentSalesList />
        </div>
      </div>
    </AppShell>
  );
}