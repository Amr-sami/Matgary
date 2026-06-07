"use client";

import { useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";

interface TrendChartProps {
  data: { date: string; revenue: number; count?: number }[];
  /** Override the default heading. Falls back to the dictionary's default. */
  title?: string;
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString("en-US");
}

export function TrendChart({ data, title }: TrendChartProps) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.insights.trend;
  const stats = useMemo(() => {
    const revenues = data.map((d) => d.revenue);
    const total = revenues.reduce((a, b) => a + b, 0);
    const nonZeroDays = revenues.filter((r) => r > 0).length || data.length || 1;
    const avg = total / nonZeroDays;
    let peak = 0;
    let peakDate = "";
    for (const d of data) {
      if (d.revenue > peak) {
        peak = d.revenue;
        peakDate = d.date;
      }
    }
    return { total, avg, peak, peakDate };
  }, [data]);

  const tickInterval = useMemo(() => {
    if (data.length <= 12) return 0;
    return Math.max(1, Math.ceil(data.length / 8) - 1);
  }, [data.length]);

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-border overflow-hidden">
      <div className="px-5 pt-5 pb-3 flex flex-wrap items-start justify-between gap-4 border-b border-border">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            {title ?? t.titleDefault}
          </h3>
          <p className="text-[11px] text-text-secondary mt-0.5">
            {t.subtitle}
          </p>
        </div>
        <div className="flex items-center gap-5 tabular-nums">
          <Stat label={t.stat.total} value={formatCurrency(stats.total, locale)} />
          <Divider />
          <Stat label={t.stat.avg} value={formatCurrency(Math.round(stats.avg), locale)} />
          <Divider />
          <Stat
            label={t.stat.peak}
            value={formatCurrency(stats.peak, locale)}
            hint={stats.peakDate}
          />
        </div>
      </div>
      <div className="h-[260px] w-full p-3 pl-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            margin={{ top: 12, right: 12, left: 4, bottom: 4 }}
          >
            <defs>
              <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1203E3" stopOpacity={0.22} />
                <stop offset="95%" stopColor="#1203E3" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              vertical={false}
              stroke="#EFEDF7"
            />
            <XAxis
              dataKey="date"
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              interval={tickInterval}
              tick={{ fontSize: 10, fill: "#6B6B6B" }}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tickMargin={4}
              width={44}
              tick={{ fontSize: 10, fill: "#6B6B6B" }}
              tickFormatter={(value: number) => formatCompact(value)}
            />
            {stats.avg > 0 && (
              <ReferenceLine
                y={stats.avg}
                stroke="#1203E3"
                strokeDasharray="4 4"
                strokeOpacity={0.35}
                ifOverflow="extendDomain"
              />
            )}
            <Tooltip
              cursor={{ stroke: "#1203E3", strokeOpacity: 0.2, strokeWidth: 1 }}
              contentStyle={{
                borderRadius: "10px",
                border: "1px solid #E8E4DC",
                boxShadow: "0 8px 20px -8px rgb(0 0 0 / 0.18)",
                fontFamily: "var(--font-cairo)",
                fontSize: "12px",
                padding: "8px 10px",
              }}
              labelStyle={{
                color: "#6B6B6B",
                fontSize: "11px",
                marginBottom: 2,
              }}
              formatter={(value) => [
                formatCurrency(Number(value || 0), locale),
                t.tooltipLabel,
              ]}
            />
            <Area
              type="monotone"
              dataKey="revenue"
              stroke="#1203E3"
              strokeWidth={2}
              fill="url(#trendFill)"
              activeDot={{
                r: 5,
                stroke: "#FFFFFF",
                strokeWidth: 2,
                fill: "#1203E3",
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="text-end">
      <p className="text-[10px] uppercase tracking-wider text-text-secondary">
        {label}
      </p>
      <p className="text-sm font-semibold text-text-primary leading-tight mt-0.5">
        {value}
      </p>
      {hint && <p className="text-[10px] text-text-secondary mt-0.5">{hint}</p>}
    </div>
  );
}

function Divider() {
  return <span className="w-px h-7 bg-border" aria-hidden />;
}
