"use client";

import { useMemo } from "react";
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
import { useDeepFetch } from "./useDeepFetch";
import { CHART_PALETTE, type DeepReportProps } from "./types";

// Stacked-bar revenue per payment method per day. Puts a clear visual signal
// on which channel is carrying the store (cash vs InstaPay vs card vs
// deferred). Totals per method are surfaced as tiles above the chart.

interface PaymentMixResponse {
  report: "payments";
  methods: string[];
  series: Array<Record<string, string | number>>;
  totals: Record<string, number>;
}

const METHOD_COLOR: Record<string, string> = {
  cash: "#22C55E",
  instapay: "#1203E3",
  card: "#0EA5E9",
  deferred: "#F59E0B",
  unknown: "#9CA3AF",
};

export function PaymentMixReport({
  window,
  branchScope,
  locale,
}: DeepReportProps) {
  const dict = useDictionary();
  const t = dict.app.insights.deep.payments;
  const { data, loading, error } = useDeepFetch<PaymentMixResponse>({
    report: "payments",
    window,
    branchScope,
  });

  const methodLabels: Record<string, string> = t.methods as Record<string, string>;

  const overallTotal = useMemo(() => {
    if (!data) return 0;
    return Object.values(data.totals).reduce((s, v) => s + Number(v ?? 0), 0);
  }, [data]);

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
  if (!data || data.series.length === 0) {
    return (
      <ReportShell title={t.title} subtitle={t.subtitle}>
        <EmptyHint text={t.empty} />
      </ReportShell>
    );
  }

  return (
    <ReportShell title={t.title} subtitle={t.subtitle}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        {data.methods.map((m, i) => {
          const value = Number(data.totals[m] ?? 0);
          const share = overallTotal === 0 ? 0 : (value / overallTotal) * 100;
          return (
            <div
              key={m}
              className="rounded-lg border border-border bg-white p-3"
            >
              <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-secondary">
                <span
                  className="inline-block w-2 h-2 rounded-sm"
                  style={{
                    backgroundColor:
                      METHOD_COLOR[m] ??
                      CHART_PALETTE[i % CHART_PALETTE.length],
                  }}
                />
                {methodLabels[m] ?? m}
              </p>
              <p className="text-lg font-bold mt-0.5 tabular-nums text-text-primary">
                {formatCurrency(value, locale)}
              </p>
              <p className="text-[11px] text-text-secondary mt-0.5">
                {share.toFixed(1)}%
              </p>
            </div>
          );
        })}
      </div>

      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data.series}
            margin={{ top: 8, right: 12, bottom: 8, left: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#666" }}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#666" }}
              tickFormatter={(v: number) => compact(v)}
            />
            <Tooltip
              formatter={(v, key) => [
                formatCurrency(Number(v ?? 0), locale),
                methodLabels[String(key)] ?? String(key),
              ]}
              labelFormatter={(l) => l}
              contentStyle={{
                borderRadius: 8,
                border: "1px solid #eaeaea",
                fontSize: 12,
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: 12 }}
              formatter={(key: string) => methodLabels[key] ?? key}
            />
            {data.methods.map((m, i) => (
              <Bar
                key={m}
                dataKey={m}
                stackId="pay"
                fill={
                  METHOD_COLOR[m] ?? CHART_PALETTE[i % CHART_PALETTE.length]
                }
                radius={
                  i === data.methods.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]
                }
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
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
