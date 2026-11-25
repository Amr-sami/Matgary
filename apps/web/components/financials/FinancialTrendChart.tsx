// Trend chart for the Financials Overview — reuses `recharts`, already in
// the project. Three stacked panels: Revenue vs Expenses, Net Profit,
// Operating Expenses by bucket. Honest with the engine's data — no React-
// side arithmetic beyond chart formatting.

"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";
import type { TrendPoint } from "@/hooks/useFinancials";

function compact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString("en-US");
}

export function FinancialTrendChart({
  data,
  seesProfit,
}: {
  data: TrendPoint[];
  seesProfit: boolean;
}) {
  const locale = useLocale();
  const isRtl = locale === "ar";

  // Prepare a lean shape for recharts — only numeric fields + label.
  const points = useMemo(
    () =>
      data.map((p) => ({
        date: p.date,
        Revenue: p.revenue,
        Expenses: p.operatingExpenses,
        NetSales: p.netSales,
        NetProfit: p.netProfit ?? 0,
      })),
    [data],
  );

  if (data.length === 0) return null;

  return (
    <div className="space-y-6">
      {/* Revenue vs Expenses */}
      <div className="bg-white rounded-xl border border-border p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-text-primary">
            {locale === "ar" ? "الإيرادات مقابل المصاريف" : "Revenue vs Expenses"}
          </h3>
        </div>
        <div style={{ width: "100%", height: 240 }}>
          <ResponsiveContainer>
            <AreaChart data={points} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
              <defs>
                <linearGradient id="revArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#1203E3" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#1203E3" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="expArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#EF4444" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#EF4444" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis
                dataKey="date"
                reversed={isRtl}
                tick={{ fontSize: 11 }}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis
                orientation={isRtl ? "right" : "left"}
                tick={{ fontSize: 11 }}
                tickFormatter={compact}
              />
              <Tooltip
                formatter={(v) => formatCurrency(Number(v), locale)}
                contentStyle={{ fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area
                type="monotone"
                dataKey="Revenue"
                stroke="#1203E3"
                fill="url(#revArea)"
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="Expenses"
                stroke="#EF4444"
                fill="url(#expArea)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Net Profit trend — only if the caller has view_profit */}
      {seesProfit && (
        <div className="bg-white rounded-xl border border-border p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-semibold text-text-primary">
              {locale === "ar" ? "اتجاه صافي الربح" : "Net Profit Trend"}
            </h3>
          </div>
          <div style={{ width: "100%", height: 200 }}>
            <ResponsiveContainer>
              <LineChart data={points} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis
                  dataKey="date"
                  reversed={isRtl}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis
                  orientation={isRtl ? "right" : "left"}
                  tick={{ fontSize: 11 }}
                  tickFormatter={compact}
                />
                <Tooltip
                  formatter={(v) => formatCurrency(Number(v), locale)}
                  contentStyle={{ fontSize: 12 }}
                />
                <Line
                  type="monotone"
                  dataKey="NetProfit"
                  stroke="#22C55E"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Horizontal bar chart of OpEx by group — fed from the P&L endpoint's
 * `operatingExpensesByGroup`. Separate component so the Overview page stays
 * tidy.
 */
export function OpexByGroupChart({
  groups,
}: {
  groups: { nameEn: string; nameAr: string; total: number }[];
}) {
  const locale = useLocale();
  const isRtl = locale === "ar";
  const data = groups
    .filter((g) => g.total > 0)
    .map((g) => ({
      name: isRtl ? g.nameAr : g.nameEn,
      Total: g.total,
    }));
  if (data.length === 0) return null;
  return (
    <div className="bg-white rounded-xl border border-border p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold text-text-primary">
          {locale === "ar" ? "توزيع المصاريف التشغيلية" : "Operating Expenses by Group"}
        </h3>
      </div>
      <div style={{ width: "100%", height: Math.max(180, data.length * 36 + 40) }}>
        <ResponsiveContainer>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 10, right: 10, left: 60, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={compact} />
            <YAxis dataKey="name" type="category" tick={{ fontSize: 11 }} width={120} />
            <Tooltip formatter={(v) => formatCurrency(Number(v), locale)} />
            <Bar dataKey="Total" fill="#5B4DEC" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
