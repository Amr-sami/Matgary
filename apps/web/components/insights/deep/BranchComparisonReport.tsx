"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { formatCurrency } from "@/lib/i18n/format";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { UserText } from "@/components/ui/UserText";
import { useDeepFetch } from "./useDeepFetch";
import type { DeepReportProps } from "./types";

// Side-by-side branch numbers — revenue, orders, AOV, margin. Owner-only,
// with the endpoint enforcing the same. Sorted by revenue on the server so
// the top-earner leads.

interface BranchRow {
  branchId: string;
  branchName: string;
  revenue: number;
  cost: number;
  grossProfit: number;
  discounts: number;
  transactions: number;
  aov: number;
  margin: number;
}
interface BranchResponse {
  report: "branches";
  rows: BranchRow[];
}

export function BranchComparisonReport({
  window,
  branchScope,
  isOwner,
  locale,
}: DeepReportProps) {
  const dict = useDictionary();
  const t = dict.app.insights.deep.branches;
  // The server requires the owner + all-branches scope. Force it — the
  // container also disables the report tile for non-owners, but keeping the
  // guard here means a lucky click can't 403.
  const scopeToUse = isOwner ? "all" : branchScope;
  const { data, loading, error } = useDeepFetch<BranchResponse>({
    report: "branches",
    window,
    branchScope: scopeToUse,
    enabled: isOwner,
  });

  if (!isOwner) {
    return (
      <ReportShell title={t.title} subtitle={t.subtitle}>
        <EmptyHint text={t.ownerOnly} />
      </ReportShell>
    );
  }

  if (loading && !data) {
    return (
      <ReportShell title={t.title} subtitle={t.subtitle}>
        <div className="h-72 animate-pulse bg-bg-main/60 rounded-lg" />
      </ReportShell>
    );
  }
  if (error) {
    return (
      <ReportShell title={t.title} subtitle={t.subtitle}>
        <EmptyHint text={error} tone="danger" />
      </ReportShell>
    );
  }
  if (!data || data.rows.length === 0) {
    return (
      <ReportShell title={t.title} subtitle={t.subtitle}>
        <EmptyHint text={t.empty} />
      </ReportShell>
    );
  }

  const chartData = data.rows.map((r) => ({
    name: r.branchName,
    revenue: r.revenue,
    cost: r.cost,
    grossProfit: r.grossProfit,
  }));

  return (
    <ReportShell title={t.title} subtitle={t.subtitle}>
      <div className="h-72 mb-6">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            margin={{ top: 8, right: 12, bottom: 8, left: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 11, fill: "#666" }}
              interval={0}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#666" }}
              tickFormatter={(v: number) => compact(v)}
            />
            <Tooltip
              formatter={(v) => formatCurrency(Number(v ?? 0), locale)}
              contentStyle={{
                borderRadius: 8,
                border: "1px solid #eaeaea",
                fontSize: 12,
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar
              dataKey="revenue"
              name={t.legend.revenue}
              fill="#1203E3"
              radius={[4, 4, 0, 0]}
            />
            <Bar
              dataKey="grossProfit"
              name={t.legend.gross}
              fill="#22C55E"
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="min-w-full text-sm">
          <thead className="bg-bg-main/60 text-xs text-text-secondary">
            <tr>
              <th className="text-start px-3 py-2 font-medium">{t.col.branch}</th>
              <th className="text-end px-3 py-2 font-medium">{t.col.revenue}</th>
              <th className="text-end px-3 py-2 font-medium">{t.col.transactions}</th>
              <th className="text-end px-3 py-2 font-medium">{t.col.aov}</th>
              <th className="text-end px-3 py-2 font-medium">{t.col.gross}</th>
              <th className="text-end px-3 py-2 font-medium">{t.col.margin}</th>
              <th className="text-end px-3 py-2 font-medium">{t.col.discounts}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.branchId} className="border-t border-border">
                <td className="px-3 py-2">
                  <UserText>{r.branchName}</UserText>
                </td>
                <td className="px-3 py-2 text-end tabular-nums text-text-primary font-medium">
                  {formatCurrency(r.revenue, locale)}
                </td>
                <td className="px-3 py-2 text-end tabular-nums">
                  {r.transactions}
                </td>
                <td className="px-3 py-2 text-end tabular-nums">
                  {formatCurrency(r.aov, locale)}
                </td>
                <td
                  className={`px-3 py-2 text-end tabular-nums ${
                    r.grossProfit >= 0 ? "text-success" : "text-danger"
                  }`}
                >
                  {formatCurrency(r.grossProfit, locale)}
                </td>
                <td
                  className={`px-3 py-2 text-end tabular-nums ${
                    r.margin >= 0 ? "" : "text-danger"
                  }`}
                >
                  {r.margin.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-end tabular-nums text-text-secondary">
                  {formatCurrency(r.discounts, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ReportShell>
  );
}

function EmptyHint({
  text,
  tone = "muted",
}: {
  text: string;
  tone?: "muted" | "danger";
}) {
  return (
    <div
      className={`h-64 rounded-lg border border-dashed flex items-center justify-center text-sm ${
        tone === "danger"
          ? "border-danger/40 text-danger bg-danger/5"
          : "border-border text-text-secondary bg-bg-main/30"
      }`}
    >
      {text}
    </div>
  );
}

function ReportShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-border overflow-hidden">
      <div className="px-5 pt-5 pb-3 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        <p className="text-[11px] text-text-secondary mt-0.5">{subtitle}</p>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function compact(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString("en-US");
}
