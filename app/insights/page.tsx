"use client";

import { useState } from "react";
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

type TabKey = "overview" | "staff";

const INSIGHTS_TABS = [
  { key: "overview" as const, label: "نظرة عامة" },
  { key: "staff" as const, label: "الموظفون" },
];

export default function InsightsPage() {
  const { data, loading } = useInsights();
  const [tab, setTab] = useState<TabKey>("overview");

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

        {tab === "staff" ? (
          <StaffPerformance />
        ) : (
          <>
            {/* Main Stats Row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-white rounded-xl p-5 shadow-sm border border-border relative overflow-hidden group">
                <div className="relative z-10">
                  <p className="text-sm text-text-secondary">مبيعات الشهر الحالي</p>
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
                    {metrics.revenueGrowth.toFixed(1)}% عن الشهر السابق
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
                <TrendChart data={trendData} />
              </div>
              <div>
                <CategoryPieChart data={categoryChartData} />
              </div>
            </div>

            {/* Details Section */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pb-6">
              <TopProducts products={topProducts} />

              <div className="bg-white rounded-xl p-6 shadow-sm border border-border flex flex-col justify-center items-center text-center space-y-4">
                <div className="bg-accent-light p-4 rounded-full">
                  <AlertCircle className="w-8 h-8 text-accent" />
                </div>
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
