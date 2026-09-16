// Server Component variant of <StatsGrid>. Replaces the client widget's
// fetch-after-mount waterfall with three parallel awaits at the SC layer.
// Same rendered output as the client version — same Tailwind classes,
// same StatCard children — so the page paints identical HTML at TTFB.
//
// The client version is kept as the offline / preview / non-dashboard
// fallback (it's used by /preview and the showcase paths). Future passes
// will delete it once the only dashboard caller is the SC version below.

import "server-only";
import { DollarSign, Package, ShoppingCart, RotateCcw } from "@/lib/icons";
import { StatCard } from "./StatCard";
import { loadDashboardStats } from "@/lib/repo/insights";
import type { Dictionary } from "@/lib/i18n/get-dictionary";
import type { Locale } from "@/lib/i18n/config";
import { formatCurrency } from "@/lib/i18n/format";

interface StatsGridServerProps {
  tenantId: string;
  /** Null → aggregate across every branch the caller can see. */
  branchId: string | null;
  dict: Dictionary;
  locale: Locale;
}

export async function StatsGridServer({
  tenantId,
  branchId,
  dict,
  locale,
}: StatsGridServerProps) {
  // Single SQL aggregation inside one withTenant tx, behind a 60 s Redis
  // cache. Replaces the old fetch-every-row-and-reduce-in-JS path that
  // shipped multi-MB JSON to compute four numbers. Cache is busted by
  // bustInsightsCache() on every sale/return/expense mutation.
  const stats = await loadDashboardStats(tenantId, branchId);
  const t = dict.app.dashboard.stats;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard
        title={t.todaySales}
        value={formatCurrency(stats.todayRevenue, locale)}
        icon={DollarSign}
        color="success"
        href="/reports?range=today"
      />
      <StatCard
        title={t.itemCount}
        value={stats.productCount}
        icon={Package}
        color="accent"
        href="/inventory"
      />
      <StatCard
        title={t.monthSales}
        value={formatCurrency(stats.monthRevenue, locale)}
        icon={ShoppingCart}
        color="accent"
        href="/sales"
      />
      <StatCard
        title={t.monthReturns}
        value={stats.monthReturns}
        icon={RotateCcw}
        color="danger"
        href="/returns"
      />
    </div>
  );
}

/** Skeleton matching the StatsGrid loading shape — used in the Suspense fallback. */
export function StatsGridSkeleton() {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="bg-white rounded-xl p-5 animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-24 mb-3" />
          <div className="h-8 bg-gray-200 rounded w-16" />
        </div>
      ))}
    </div>
  );
}
