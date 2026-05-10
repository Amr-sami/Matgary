"use client";

import { useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { AppShell } from "@/components/layout/AppShell";
import { useInsights, type InsightsBranchScope } from "@/hooks/useInsights";
import { useBranches } from "@/hooks/useBranches";
import { TrendChart } from "@/components/insights/TrendChart";
import { CategoryPieChart } from "@/components/insights/CategoryPieChart";
import { TopProducts } from "@/components/insights/TopProducts";
import { StaffPerformance } from "@/components/insights/StaffPerformance";
import { StatCard } from "@/components/dashboard/StatCard";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { Tabs } from "@/components/ui/Tabs";
import { CATEGORY_LABELS, type Category } from "@/lib/types";
import { formatPrice } from "@/lib/utils";
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Percent,
  ShoppingCart,
} from "@/lib/icons";
import {
  DATE_RANGE_LABELS,
  type DateRangeKey,
} from "@/components/sales/SalesFilters";

type TabKey = "overview" | "staff";

const INSIGHTS_TABS = [
  { key: "overview" as const, label: "نظرة عامة" },
  { key: "staff" as const, label: "الموظفون" },
];

const DATE_FILTER_ORDER: DateRangeKey[] = [
  "all",
  "today",
  "yesterday",
  "7d",
  "30d",
  "thisMonth",
  "custom",
];

function resolveInsightsWindow(
  key: DateRangeKey,
  customFrom: string,
  customTo: string,
): { from?: Date; to?: Date } | null {
  if (key === "all") return null;
  const now = new Date();
  const startOfDay = (d: Date) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const endOfDay = (d: Date) => {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
  };
  switch (key) {
    case "today":
      return { from: startOfDay(now), to: endOfDay(now) };
    case "yesterday": {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { from: startOfDay(y), to: endOfDay(y) };
    }
    case "7d": {
      const f = new Date(now);
      f.setDate(f.getDate() - 6);
      return { from: startOfDay(f), to: endOfDay(now) };
    }
    case "30d": {
      const f = new Date(now);
      f.setDate(f.getDate() - 29);
      return { from: startOfDay(f), to: endOfDay(now) };
    }
    case "thisMonth": {
      const f = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: f, to: endOfDay(now) };
    }
    case "custom": {
      if (!customFrom && !customTo) return null;
      const from = customFrom ? startOfDay(new Date(customFrom)) : undefined;
      const to = customTo ? endOfDay(new Date(customTo)) : endOfDay(now);
      if (from && Number.isNaN(from.valueOf())) return null;
      if (to && Number.isNaN(to.valueOf())) return null;
      return { from, to };
    }
  }
}

const COMPARISON_LABEL: Record<DateRangeKey, string> = {
  all: "عن الشهر السابق",
  today: "عن الأمس",
  yesterday: "عن اليوم السابق",
  "7d": "عن الـ 7 أيام السابقة",
  "30d": "عن الـ 30 يوم السابقة",
  thisMonth: "عن نفس الفترة من الشهر السابق",
  custom: "عن الفترة السابقة بنفس المدة",
};

export default function InsightsPage() {
  const { data: session } = useSession();
  const isOwner = session?.user?.role === "owner";
  const { branches: accessibleBranches, current: activeBranch } = useBranches();

  const [tab, setTab] = useState<TabKey>("overview");
  const [dateRange, setDateRange] = useState<DateRangeKey>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  // Branch scope: "active" follows the topbar picker; "all" merges every
  // branch (owner only). Default for owner is "all" so they see the merged
  // view they're used to; staff always see their active branch.
  const [branchScope, setBranchScope] = useState<"active" | "all">("active");
  const showBranchToggle = isOwner && accessibleBranches.length > 1;
  const branchScopeParam: InsightsBranchScope =
    branchScope === "all" ? "all" : undefined;

  const insightsWindow = useMemo(
    () => resolveInsightsWindow(dateRange, customFrom, customTo) ?? undefined,
    [dateRange, customFrom, customTo],
  );
  const { data, loading } = useInsights(insightsWindow, branchScopeParam);
  const headlineLabel =
    dateRange === "all"
      ? "مبيعات الشهر الحالي"
      : `مبيعات الفترة (${DATE_RANGE_LABELS[dateRange]})`;

  if (loading) {
    return (
      <AppShell title="الإحصائيات">
        <PageSkeleton chart rows={5} />
      </AppShell>
    );
  }

  if (!data) return null;

  const { metrics, trendData, topProducts, categoryChartData } = data;
  const isPositive = metrics.revenueGrowth >= 0;

  const highlights = computeHighlights(trendData, topProducts, categoryChartData);

  return (
    <AppShell title="تحليلات العمل">
      <div className="space-y-5">
        <Tabs items={INSIGHTS_TABS} active={tab} onChange={setTab} />

        {showBranchToggle && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-secondary">النطاق:</span>
            <div className="inline-flex rounded-lg border border-border bg-white overflow-hidden text-xs">
              <button
                type="button"
                onClick={() => setBranchScope("active")}
                className={`px-3 py-1.5 transition-colors ${
                  branchScope === "active"
                    ? "bg-accent text-white"
                    : "text-text-secondary hover:bg-bg-main"
                }`}
              >
                {activeBranch?.name ?? "الفرع الحالي"}
              </button>
              <button
                type="button"
                onClick={() => setBranchScope("all")}
                className={`px-3 py-1.5 transition-colors border-s border-border ${
                  branchScope === "all"
                    ? "bg-accent text-white"
                    : "text-text-secondary hover:bg-bg-main"
                }`}
              >
                كل الفروع
              </button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {DATE_FILTER_ORDER.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setDateRange(key)}
                className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                  dateRange === key
                    ? "bg-accent text-white border-accent"
                    : "bg-white border-border text-text-secondary hover:border-accent"
                }`}
              >
                {DATE_RANGE_LABELS[key]}
              </button>
            ))}
          </div>
          {dateRange === "custom" && (
            <div className="flex flex-wrap items-end gap-3 bg-white border border-border rounded-lg p-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-text-secondary">من</label>
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="px-3 py-1.5 rounded-md border border-border focus:outline-none focus:border-accent"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-text-secondary">إلى</label>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="px-3 py-1.5 rounded-md border border-border focus:outline-none focus:border-accent"
                />
              </div>
              {(customFrom || customTo) && (
                <button
                  type="button"
                  onClick={() => {
                    setCustomFrom("");
                    setCustomTo("");
                  }}
                  className="text-xs text-text-secondary hover:text-danger px-2 py-1.5"
                >
                  مسح
                </button>
              )}
            </div>
          )}
        </div>

        {tab === "staff" ? (
          <StaffPerformance
            window={insightsWindow}
            rangeLabel={
              dateRange === "all"
                ? "آخر 30 يوم (افتراضي)"
                : DATE_RANGE_LABELS[dateRange]
            }
          />
        ) : (
          <>
            {/* KPI row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <RevenueCard
                label={headlineLabel}
                value={metrics.currentRevenue}
                growth={metrics.revenueGrowth}
                isPositive={isPositive}
                comparison={COMPARISON_LABEL[dateRange]}
              />

              <StatCard
                title="إجمالي المبيعات"
                value={metrics.totalSales}
                subtitle="عملية بيع"
                icon={ShoppingCart}
                color="accent"
              />

              <StatCard
                title="صافي الربح"
                value={formatPrice(metrics.netProfit)}
                subtitle="بعد المصاريف والتكلفة"
                icon={TrendingUp}
                color={metrics.netProfit >= 0 ? "success" : "danger"}
              />

              <StatCard
                title="إجمالي الخصومات"
                value={formatPrice(metrics.totalDiscounts)}
                subtitle={`${metrics.discountPercent.toFixed(1)}% من القيمة`}
                icon={Percent}
                color="danger"
              />
            </div>

            {/* Charts: trend (2/3) + category (1/3) */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              <div className="lg:col-span-2">
                <TrendChart
                  data={trendData}
                  title={
                    dateRange === "all"
                      ? "اتجاه المبيعات (آخر 30 يوم)"
                      : `اتجاه المبيعات (${DATE_RANGE_LABELS[dateRange]})`
                  }
                />
              </div>
              <div>
                <CategoryPieChart data={categoryChartData} />
              </div>
            </div>

            {/* Detail grid: top products + highlights */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 pb-6">
              <TopProducts products={topProducts} />
              <HighlightsPanel
                items={highlights}
                netProfit={metrics.netProfit}
                totalExpenses={metrics.totalExpenses}
                grossProfit={metrics.grossProfit}
              />
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

function RevenueCard({
  label,
  value,
  growth,
  isPositive,
  comparison,
}: {
  label: string;
  value: number;
  growth: number;
  isPositive: boolean;
  comparison: string;
}) {
  return (
    <div className="bg-white rounded-xl p-5 shadow-sm border border-border h-full">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-text-secondary">{label}</p>
          <p className="text-2xl font-bold mt-1 tabular-nums">
            {formatPrice(value)}
          </p>
        </div>
        <DollarSign className="w-6 h-6 text-accent shrink-0" />
      </div>
      <div
        className={`mt-3 inline-flex items-center gap-1 text-xs font-semibold tabular-nums px-2 py-1 rounded-md ${
          isPositive
            ? "bg-success-light text-success"
            : "bg-danger-light text-danger"
        }`}
      >
        {isPositive ? (
          <TrendingUp className="w-3.5 h-3.5" />
        ) : (
          <TrendingDown className="w-3.5 h-3.5" />
        )}
        {isPositive ? "+" : ""}
        {growth.toFixed(1)}%
        <span className="font-normal opacity-80 mr-1">{comparison}</span>
      </div>
    </div>
  );
}

interface Highlight {
  label: string;
  value: string;
  hint?: string;
}

function computeHighlights(
  trendData: { date: string; revenue: number; count?: number }[],
  topProducts: { name: string; revenue: number; qty: number }[],
  categoryChartData: { name: string; value: number }[],
): Highlight[] {
  const result: Highlight[] = [];

  if (trendData.length > 0) {
    const total = trendData.reduce((s, d) => s + d.revenue, 0);
    const nonZeroDays = trendData.filter((d) => d.revenue > 0).length;
    const denom = nonZeroDays || trendData.length;
    const avg = total / denom;
    let peak = trendData[0];
    for (const d of trendData) if (d.revenue > peak.revenue) peak = d;
    if (peak.revenue > 0) {
      result.push({
        label: "أفضل يوم مبيعات",
        value: formatPrice(peak.revenue),
        hint: peak.date,
      });
    }
    if (avg > 0) {
      result.push({
        label: "المتوسط اليومي",
        value: formatPrice(Math.round(avg)),
        hint: `على ${denom} يوم`,
      });
    }
  }

  if (topProducts.length > 0 && topProducts[0].revenue > 0) {
    const total = topProducts.reduce((s, p) => s + p.revenue, 0);
    const share = total === 0 ? 0 : (topProducts[0].revenue / total) * 100;
    result.push({
      label: "أعلى منتج",
      value: topProducts[0].name,
      hint: `${share.toFixed(1)}% من أعلى 5`,
    });
  }

  if (categoryChartData.length > 0) {
    const sorted = [...categoryChartData].sort((a, b) => b.value - a.value);
    const total = sorted.reduce((s, d) => s + d.value, 0);
    const top = sorted[0];
    if (top && total > 0) {
      const share = (top.value / total) * 100;
      const label = CATEGORY_LABELS[top.name as Category] || top.name;
      result.push({
        label: "أعلى صنف",
        value: label,
        hint: `${share.toFixed(1)}% من الإيراد`,
      });
    }
  }

  return result;
}

function HighlightsPanel({
  items,
  netProfit,
  totalExpenses,
  grossProfit,
}: {
  items: Highlight[];
  netProfit: number;
  totalExpenses: number;
  grossProfit: number;
}) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-border overflow-hidden h-full flex flex-col">
      <div className="px-5 pt-5 pb-3 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary">
          ملخص الفترة
        </h3>
        <p className="text-[11px] text-text-secondary mt-0.5">
          نقاط رئيسية مستخرجة من بيانات الفترة المختارة
        </p>
      </div>

      {items.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <p className="text-sm text-text-secondary">
            لا توجد بيانات كافية لإنتاج ملخص.
          </p>
        </div>
      ) : (
        <>
          <ul className="grid grid-cols-2 divide-x divide-y divide-border [direction:rtl]">
            {items.map((h) => (
              <li key={h.label} className="p-4">
                <p className="text-[10px] uppercase tracking-wider text-text-secondary">
                  {h.label}
                </p>
                <p className="text-sm font-semibold text-text-primary mt-1 truncate tabular-nums">
                  {h.value}
                </p>
                {h.hint && (
                  <p className="text-[11px] text-text-secondary mt-0.5">
                    {h.hint}
                  </p>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-auto px-5 py-4 border-t border-border bg-bg-main/40 space-y-2">
            <FinancialRow
              label="إجمالي الربح"
              value={formatPrice(grossProfit)}
            />
            <FinancialRow
              label="مصاريف تشغيلية"
              value={formatPrice(totalExpenses)}
              negative
            />
            <FinancialRow
              label="صافي الربح"
              value={formatPrice(netProfit)}
              emphasized
              positive={netProfit >= 0}
            />
          </div>
        </>
      )}
    </div>
  );
}

function FinancialRow({
  label,
  value,
  negative,
  emphasized,
  positive,
}: {
  label: string;
  value: string;
  negative?: boolean;
  emphasized?: boolean;
  positive?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span
        className={
          emphasized ? "font-semibold text-text-primary" : "text-text-secondary"
        }
      >
        {label}
      </span>
      <span
        className={`tabular-nums ${
          emphasized
            ? positive
              ? "font-bold text-success"
              : "font-bold text-danger"
            : negative
              ? "text-danger"
              : "font-medium text-text-primary"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
