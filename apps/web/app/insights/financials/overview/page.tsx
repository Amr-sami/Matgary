// /insights/financials/overview — flat KPI view backed by
// GET /api/financials/overview. All numbers come from the server; the UI
// never recomputes P&L.

"use client";

import { useState } from "react";
import { StatCard } from "@/components/dashboard/StatCard";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { formatCurrency } from "@/lib/i18n/format";
import { useLocale, useDictionary } from "@/components/i18n/DictionaryProvider";
import { TrendingUp, DollarSign, Wallet, Receipt } from "@/lib/icons";
import { useFinancialOverview, useFinancialPnL, useFinancialTrends } from "@/hooks/useFinancials";
import { PresetChips } from "@/components/financials/PresetChips";
import { FinancialTrendChart, OpexByGroupChart } from "@/components/financials/FinancialTrendChart";
import type { DatePresetKey } from "@/lib/finance/dates";

export default function FinancialsOverviewPage() {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.financials;

  const [preset, setPreset] = useState<DatePresetKey>("this_month");
  const [customFrom, setCustomFrom] = useState<string | undefined>();
  const [customTo, setCustomTo] = useState<string | undefined>();
  const range = { preset, from: customFrom, to: customTo };
  const { data, loading, error, forbidden, refresh } = useFinancialOverview(range);
  // Auxiliary fetches — charts + OpEx group breakdown. Each one gracefully
  // renders nothing if it fails; the Overview numbers are the priority.
  const trends = useFinancialTrends(range);
  const pnl = useFinancialPnL(range);

  return (
    <div className="space-y-5">
      <PresetChips
        value={preset}
        onChange={setPreset}
        customFrom={customFrom}
        customTo={customTo}
        onCustomChange={(from, to) => {
          setCustomFrom(from || undefined);
          setCustomTo(to || undefined);
        }}
      />

      {forbidden ? (
        <ForbiddenPanel />
      ) : loading && !data ? (
        // Cold load → skeleton. Background refetch keeps cached data visible.
        <PageSkeleton rows={6} />
      ) : error && !data ? (
        <ErrorPanel message={error} onRetry={refresh} />
      ) : !data ? (
        <EmptyPanel />
      ) : (
        <>
          {/* Primary revenue + margin KPIs. StatCard uses the existing
              simple text-colour icon treatment — no decorative circles. */}
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              title={t.kpi.netSales}
              value={formatCurrency(data.netSales, locale)}
              subtitle={t.kpiHint.netSales}
              icon={DollarSign}
              color="accent"
            />
            <StatCard
              title={t.kpi.cogs}
              value={formatCurrency(data.cogs, locale)}
              subtitle={t.kpiHint.cogs}
              icon={Receipt}
              color="accent"
            />
            <StatCard
              title={t.kpi.grossProfit}
              value={formatCurrency(data.grossProfit, locale)}
              subtitle={formatMarginSubtitle(data.grossMargin, t.margin.unit, locale)}
              icon={TrendingUp}
              color={data.grossProfit >= 0 ? "success" : "danger"}
            />
            <StatCard
              title={t.kpi.operatingExpenses}
              value={formatCurrency(data.operatingExpenses, locale)}
              subtitle={t.kpiHint.operatingExpenses}
              icon={Wallet}
              color="danger"
            />
          </section>

          {/* Secondary line: operating profit, net profit, margin, counts. */}
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              title={t.kpi.operatingProfit}
              value={formatCurrency(data.operatingProfit, locale)}
              icon={TrendingUp}
              color={data.operatingProfit >= 0 ? "success" : "danger"}
            />
            <StatCard
              title={t.kpi.netProfit}
              value={formatCurrency(data.netProfit, locale)}
              subtitle={t.kpiHint.netProfit}
              icon={TrendingUp}
              color={data.netProfit >= 0 ? "success" : "danger"}
            />
            <StatCard
              title={t.kpi.netMargin}
              value={`${(data.netMargin * 100).toFixed(1)}${t.margin.unit}`}
              icon={TrendingUp}
              color={data.netMargin >= 0 ? "success" : "danger"}
            />
            <StatCard
              title={t.kpi.salesCount}
              value={String(data.salesCount)}
              subtitle={`${t.kpi.returnsCount}: ${data.returnsCount}`}
              icon={Receipt}
              color="accent"
            />
          </section>

          {/* Breakdown row: gross sales / discounts / returns + money
              movements. Money movements are explicitly separate from P&L. */}
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white rounded-xl p-5 shadow-sm border border-border space-y-3">
              <Row label={t.kpi.grossSales} value={formatCurrency(data.grossSales, locale)} />
              <Row
                label={t.kpi.discounts}
                value={`− ${formatCurrency(data.discounts, locale)}`}
                negative={data.discounts > 0}
              />
              <Row
                label={t.kpi.returns}
                value={`− ${formatCurrency(data.returnsRevenue, locale)}`}
                negative={data.returnsRevenue > 0}
              />
              <div className="border-t border-border pt-3">
                <Row
                  label={t.kpi.netSales}
                  value={formatCurrency(data.netSales, locale)}
                  emphasized
                />
              </div>
            </div>
            <div className="bg-white rounded-xl p-5 shadow-sm border border-border space-y-3">
              <Row
                label={t.kpi.moneyIn}
                value={formatCurrency(data.moneyIn, locale)}
                emphasized={data.moneyIn > 0}
              />
              <Row
                label={t.kpi.moneyOut}
                value={formatCurrency(data.moneyOut, locale)}
                negative={data.moneyOut > 0}
              />
              <p className="text-xs text-text-secondary pt-2 border-t border-border">
                {/* Clarify that movements are NOT P&L — same wording used
                    inside the engine docs. */}
                {locale === "ar"
                  ? "الحركات المالية مُنفصلة تمامًا عن الأرباح والخسائر."
                  : "Money movements are kept separate from profit and loss."}
              </p>
            </div>
          </section>

          {/* Charts — render only when the trend payload arrived. If a user
              doesn't have view_profit the chart still shows revenue +
              expenses; the Net Profit trend is simply hidden by the
              component itself. */}
          {trends.data && trends.data.data.length > 0 && (
            <FinancialTrendChart
              data={trends.data.data}
              seesProfit={trends.data.seesProfit}
            />
          )}
          {pnl.data && pnl.data.data.operatingExpensesByGroup.length > 0 && (
            <OpexByGroupChart
              groups={pnl.data.data.operatingExpensesByGroup.map((g) => ({
                nameEn: g.groupNameEn,
                nameAr: g.groupNameAr,
                total: g.total,
              }))}
            />
          )}
        </>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  negative,
  emphasized,
}: {
  label: string;
  value: string;
  negative?: boolean;
  emphasized?: boolean;
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
        className={
          "tabular-nums " +
          (emphasized
            ? "font-bold text-text-primary"
            : negative
              ? "text-danger"
              : "font-medium text-text-primary")
        }
      >
        {value}
      </span>
    </div>
  );
}

function formatMarginSubtitle(
  margin: number,
  unit: string,
  _locale: string,
): string {
  if (!Number.isFinite(margin)) return "—";
  return `${(margin * 100).toFixed(1)}${unit}`;
}

function ForbiddenPanel() {
  const locale = useLocale();
  // Inline strings — no `financials.forbidden` key existed and this UI is
  // rendered only when the backend returns 403, so we don't spend a dict
  // round-trip here. Future refactor can promote to i18n if needed.
  const title = locale === "ar" ? "ليست لديك صلاحية الوصول" : "You don't have access";
  const hint =
    locale === "ar"
      ? "تحتاج صلاحية view_financials للوصول إلى هذه الصفحة."
      : "You need the view_financials permission to open this page.";
  return (
    <div className="bg-white rounded-xl border border-border p-8 text-center space-y-2">
      <h3 className="font-semibold text-text-primary">{title}</h3>
      <p className="text-sm text-text-secondary">{hint}</p>
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  const dict = useDictionary();
  const t = dict.app.financials.error;
  return (
    <div className="bg-white rounded-xl border border-danger-light p-8 text-center space-y-3">
      <h3 className="font-semibold text-danger">{t.title}</h3>
      <p className="text-sm text-text-secondary">{t.hint}</p>
      <p className="text-xs text-text-secondary font-mono">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="px-4 py-2 rounded-lg border border-border bg-white hover:bg-bg-main text-sm"
      >
        {t.retry}
      </button>
    </div>
  );
}

function EmptyPanel() {
  const dict = useDictionary();
  const t = dict.app.financials.empty;
  return (
    <div className="bg-white rounded-xl border border-border p-8 text-center space-y-2">
      <h3 className="font-semibold text-text-primary">{t.title}</h3>
      <p className="text-sm text-text-secondary">{t.hint}</p>
    </div>
  );
}
