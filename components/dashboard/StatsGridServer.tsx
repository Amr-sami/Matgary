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
import { listSales, listReturns } from "@/lib/repo/operations";
import { listProducts } from "@/lib/repo/catalog";
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
  // Three repo reads in parallel inside the same component scope. Each
  // opens its own `withTenant` transaction; this matches what the API
  // route does today and keeps RLS as the safety net.
  const [products, sales, returns] = await Promise.all([
    listProducts(tenantId, branchId),
    listSales(tenantId, branchId),
    listReturns(tenantId, branchId),
  ]);
  const t = dict.app.dashboard.stats;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const todaySales = sales
    .filter((s) => new Date(s.saleDate) >= today)
    .reduce((sum, s) => sum + s.totalPrice, 0);

  const monthSales = sales
    .filter((s) => new Date(s.saleDate) >= thisMonth)
    .reduce((sum, s) => sum + s.totalPrice, 0);

  const monthReturns = returns.filter(
    (r) => new Date(r.returnDate) >= thisMonth,
  ).length;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard
        title={t.todaySales}
        value={formatCurrency(todaySales, locale)}
        icon={DollarSign}
        color="success"
        href="/reports?range=today"
      />
      <StatCard
        title={t.itemCount}
        value={products.length}
        icon={Package}
        color="accent"
        href="/inventory"
      />
      <StatCard
        title={t.monthSales}
        value={formatCurrency(monthSales, locale)}
        icon={ShoppingCart}
        color="accent"
        href="/sales"
      />
      <StatCard
        title={t.monthReturns}
        value={monthReturns}
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
