"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { useInsights } from "@/hooks/useInsights";
import { TrendChart } from "@/components/insights/TrendChart";
import { CategoryPieChart } from "@/components/insights/CategoryPieChart";
import { TopProducts } from "@/components/insights/TopProducts";
import { StaffPerformance } from "@/components/insights/StaffPerformance";
import { StatCard } from "@/components/dashboard/StatCard";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { Tabs } from "@/components/ui/Tabs";
import { formatPrice } from "@/lib/utils";
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Percent,
  ShoppingCart,
  AlertCircle,
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
  const [tab, setTab] = useState<TabKey>("overview");
  const [dateRange, setDateRange] = useState<DateRangeKey>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const insightsWindow = useMemo(
    () => resolveInsightsWindow(dateRange, customFrom, customTo) ?? undefined,
    [dateRange, customFrom, customTo],
  );
  const { data, loading } = useInsights(insightsWindow);
  const headlineLabel =
    dateRange === "all"
      ? "مبيعات الشهر الحالي"
      : `مبيعات الفترة المختارة (${DATE_RANGE_LABELS[dateRange]})`;

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

  return (
    <AppShell title="تحليلات العمل">
      <div className="space-y-6">
        <Tabs items={INSIGHTS_TABS} active={tab} onChange={setTab} />

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
            {/* Main Stats Row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-white rounded-xl p-5 shadow-sm border border-border relative overflow-hidden group">
                <div className="relative z-10">
                  <p className="text-sm text-text-secondary">{headlineLabel}</p>
                  <p className="text-2xl font-bold mt-1">{formatPrice(metrics.currentRevenue)}</p>
                  <div
                    className={`flex items-center gap-1 mt-2 text-xs font-bold ${
                      isPositive ? "text-success" : "text-danger"
                    }`}
                  >
                    {isPositive ? (
                      <TrendingUp className="w-3.5 h-3.5" />
                    ) : (
                      <TrendingDown className="w-3.5 h-3.5" />
                    )}
                    {isPositive ? "+" : ""}
                    {metrics.revenueGrowth.toFixed(1)}% {COMPARISON_LABEL[dateRange]}
                  </div>
                </div>
                <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                  <DollarSign className="w-12 h-12" />
                </div>
              </div>

              <StatCard
                title="إجمالي الخصومات"
                value={formatPrice(metrics.totalDiscounts)}
                subtitle={`${metrics.discountPercent.toFixed(1)}% من القيمة الإجمالية`}
                icon={Percent}
                color="danger"
              />

              <StatCard
                title="إجمالي المبيعات"
                value={metrics.totalSales}
                subtitle="عملية بيع"
                icon={ShoppingCart}
                color="accent"
              />

              <StatCard
                title="إجمالي المصاريف"
                value={formatPrice(metrics.totalExpenses)}
                subtitle="تكاليف تشغيلية"
                icon={DollarSign}
                color="danger"
              />

              <StatCard
                title="صافي الربح"
                value={formatPrice(metrics.netProfit)}
                subtitle="بعد خصم المصاريف والتكلفة"
                icon={TrendingUp}
                color={metrics.netProfit >= 0 ? "success" : "danger"}
              />
            </div>

            {/* Charts Section */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
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

            {/* Details Section */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pb-6">
              <TopProducts products={topProducts} />

              <div className="bg-white rounded-xl p-6 shadow-sm border border-border flex flex-col justify-center items-center text-center space-y-4">
                <AlertCircle className="w-8 h-8 text-accent" />
                <div>
                  <h3 className="text-lg font-bold">بصيرة الذكاء الاصطناعي</h3>
                  <p className="text-sm text-text-secondary mt-2 max-w-sm leading-relaxed">
                    المبيعات هذا الشهر {isPositive ? "مرتفعة" : "منخفضة"} بنسبة{" "}
                    {Math.abs(metrics.revenueGrowth).toFixed(1)}%.
                    {metrics.netProfit > 0
                      ? ` صافي الربح الحالي هو ${formatPrice(metrics.netProfit)} بعد تغطية كافة المصاريف.`
                      : " صافي الربح بالسالب حالياً، يرجى مراجعة المصاريف أو تحسين وتيرة البيع."}
                    {metrics.discountPercent > 10 &&
                      " نسبة الخصومات قد تؤثر على هوامش الربح على المدى الطويل."}
                  </p>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
