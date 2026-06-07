"use client";

import { AppShell } from "@/components/layout/AppShell";
import { useReturns } from "@/hooks/useReturns";
import { ReturnsTable } from "@/components/returns/ReturnsTable";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

export default function ReturnsPage() {
  const dict = useDictionary();
  const t = dict.app.returns;
  const { returns, loading } = useReturns();

  if (loading) {
    return (
      <AppShell title={t.title}>
        <PageSkeleton rows={6} cards={false} />
      </AppShell>
    );
  }

  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const monthReturns = returns.filter(
    (r) => new Date(r.returnDate) >= thisMonth
  ).length;

  return (
    <AppShell title={t.title}>
      <div className="space-y-6">
        <div className="bg-white rounded-xl p-5 shadow-sm border border-border">
          <p className="text-sm text-text-secondary">{t.monthLabel}</p>
          <p className="text-2xl font-bold text-danger mt-1">{monthReturns}</p>
        </div>

        {returns.length === 0 ? (
          <EmptyState type="returns" />
        ) : (
          <ReturnsTable returns={returns} />
        )}
      </div>
    </AppShell>
  );
}
