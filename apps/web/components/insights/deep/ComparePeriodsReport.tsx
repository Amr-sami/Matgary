"use client";

import { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { TrendingDown, TrendingUp } from "@/lib/icons";
import { formatCurrency } from "@/lib/i18n/format";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { useDeepFetch } from "./useDeepFetch";
import type { DeepReportProps } from "./types";

// Overlay the selected window against the equal-length window immediately
// preceding it. Aligned by day-index so a 7-day period lines up point-for-
// point against the previous 7 days on the same x-axis.

interface CompareResponse {
  report: "compare";
  window: { from: string; to: string };
  previousWindow: { from: string; to: string };
  points: Array<{
    dayIndex: number;
    label: string;
    current: number;
    previous: number;
  }>;
  totals: { current: number; previous: number; growth: number };
}

export function ComparePeriodsReport({
  window,
  branchScope,
  locale,
}: DeepReportProps) {
  const dict = useDictionary();
  const t = dict.app.insights.deep.compare;
  const hasWindow = !!(window?.from && window?.to);
  const { data, loading, error } = useDeepFetch<CompareResponse>({
    report: "compare",
    window,
    branchScope,
    enabled: hasWindow,
  });

  const chart = useMemo(() => data?.points ?? [], [data]);
  const totals = data?.totals ?? { current: 0, previous: 0, growth: 0 };
  const positive = totals.growth >= 0;

  if (!hasWindow) {
    return (
      <ReportShell title={t.title} subtitle={t.subtitle}>
        <EmptyHint text={t.needsWindow} />
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
  if (!data || chart.length === 0) {
    return (
      <ReportShell title={t.title} subtitle={t.subtitle}>
        <EmptyHint text={t.empty} />
      </ReportShell>
    );
  }

  return (
    <ReportShell title={t.title} subtitle={t.subtitle}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <TotalTile
          label={t.currentTotal}
          value={formatCurrency(totals.current, locale)}
          tone="accent"
        />
        <TotalTile
          label={t.previousTotal}
          value={formatCurrency(totals.previous, locale)}
          tone="muted"
        />
        <div className="rounded-lg border border-border bg-white p-3">
          <p className="text-[10px] uppercase tracking-wider text-text-secondary">
            {t.growth}
          </p>
          <p
            className={`text-lg font-bold mt-0.5 tabular-nums inline-flex items-center gap-1 ${
              positive ? "text-success" : "text-danger"
            }`}
          >
            {positive ? (
              <TrendingUp className="w-4 h-4" />
            ) : (
              <TrendingDown className="w-4 h-4" />
            )}
            {positive ? "+" : ""}
            {totals.growth.toFixed(1)}%
          </p>
        </div>
      </div>

      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chart} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
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
              formatter={(v) => formatCurrency(Number(v ?? 0), locale)}
              labelFormatter={(l) => l}
              contentStyle={{
                borderRadius: 8,
                border: "1px solid #eaeaea",
                fontSize: 12,
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line
              type="monotone"
              dataKey="current"
              name={t.legend.current}
              stroke="#1203E3"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="previous"
              name={t.legend.previous}
              stroke="#9C92F3"
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ReportShell>
  );
}

function TotalTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "accent" | "muted";
}) {
  return (
    <div className="rounded-lg border border-border bg-white p-3">
      <p className="text-[10px] uppercase tracking-wider text-text-secondary">
        {label}
      </p>
      <p
        className={`text-lg font-bold mt-0.5 tabular-nums ${
          tone === "accent" ? "text-accent" : "text-text-primary"
        }`}
      >
        {value}
      </p>
    </div>
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
