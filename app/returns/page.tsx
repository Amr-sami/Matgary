"use client";

import { AppShell } from "@/components/layout/AppShell";
import { useReturns } from "@/hooks/useReturns";
import { ReturnsTable } from "@/components/returns/ReturnsTable";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { EmptyState } from "@/components/ui/EmptyState";

export default function ReturnsPage() {
  const { returns, loading } = useReturns();

  if (loading) {
    return (
      <AppShell title="المرتجعات">
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
    <AppShell title="المرتجعات">
      <div className="space-y-6">
        <div className="bg-white rounded-xl p-5 shadow-sm border border-border">
          <p className="text-sm text-text-secondary">مرتجعات الشهر</p>
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