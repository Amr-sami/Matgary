"use client";

import { useMemo } from "react";
import { formatCurrency } from "@/lib/i18n/format";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { useDeepFetch } from "./useDeepFetch";
import type { DeepReportProps } from "./types";

// 7×24 grid — rows are days-of-week (Sun..Sat in Postgres extract(dow)),
// columns are the hour buckets 0..23. Cell colour is a linear ramp from
// bg-main to the accent based on revenue.

interface HeatmapCell {
  dow: number;
  hour: number;
  revenue: number;
  count: number;
}

interface HeatmapResponse {
  report: "heatmap";
  cells: HeatmapCell[];
  peak: HeatmapCell | null;
}

const DAY_NAMES: Record<"ar" | "en", readonly string[]> = {
  ar: ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};

export function TimeHeatmapReport({
  window,
  branchScope,
  locale,
}: DeepReportProps) {
  const dict = useDictionary();
  const t = dict.app.insights.deep.heatmap;
  const { data, loading, error } = useDeepFetch<HeatmapResponse>({
    report: "heatmap",
    window,
    branchScope,
  });

  const { grid, maxRevenue, dayTotals, hourTotals } = useMemo(() => {
    const grid: Array<Array<HeatmapCell | null>> = Array.from({ length: 7 }, () =>
      Array(24).fill(null),
    );
    let maxRevenue = 0;
    const dayTotals = new Array<number>(7).fill(0);
    const hourTotals = new Array<number>(24).fill(0);
    for (const c of data?.cells ?? []) {
      if (c.dow >= 0 && c.dow < 7 && c.hour >= 0 && c.hour < 24) {
        grid[c.dow][c.hour] = c;
        if (c.revenue > maxRevenue) maxRevenue = c.revenue;
        dayTotals[c.dow] += c.revenue;
        hourTotals[c.hour] += c.revenue;
      }
    }
    return { grid, maxRevenue, dayTotals, hourTotals };
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
  if (!data || !data.cells || maxRevenue === 0) {
    return (
      <ReportShell title={t.title} subtitle={t.subtitle}>
        <EmptyHint text={t.empty} />
      </ReportShell>
    );
  }

  const days = DAY_NAMES[locale];

  return (
    <ReportShell title={t.title} subtitle={t.subtitle}>
      {data.peak && (
        <div className="mb-4 flex items-center gap-2 text-xs text-text-secondary">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-accent" />
          {t.peakLine
            .replace("{day}", days[data.peak.dow])
            .replace("{hour}", String(data.peak.hour).padStart(2, "0"))
            .replace("{revenue}", formatCurrency(data.peak.revenue, locale))}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead>
            <tr>
              <th className="text-start text-text-secondary font-medium py-1 pe-2 sticky start-0 bg-white">
                {t.dayHeader}
              </th>
              {Array.from({ length: 24 }, (_, h) => (
                <th
                  key={h}
                  className={`text-center text-text-secondary font-medium py-1 tabular-nums ${
                    h % 3 === 0 ? "" : "opacity-60"
                  }`}
                  style={{ minWidth: 22 }}
                >
                  {String(h).padStart(2, "0")}
                </th>
              ))}
              <th className="text-end text-text-secondary font-medium py-1 ps-2">
                {t.rowTotal}
              </th>
            </tr>
          </thead>
          <tbody>
            {grid.map((row, dow) => (
              <tr key={dow}>
                <td className="text-text-secondary font-medium py-0.5 pe-2 whitespace-nowrap sticky start-0 bg-white">
                  {days[dow]}
                </td>
                {row.map((cell, hour) => (
                  <HeatCell
                    key={hour}
                    cell={cell}
                    max={maxRevenue}
                    day={days[dow]}
                    hour={hour}
                    locale={locale}
                    tooltipTemplate={t.cellTooltip}
                  />
                ))}
                <td className="text-end tabular-nums py-0.5 ps-2 text-text-primary font-medium">
                  {compactCurrency(dayTotals[dow], locale)}
                </td>
              </tr>
            ))}
            <tr>
              <td className="text-text-secondary font-medium py-1 pe-2 sticky start-0 bg-white">
                {t.hourTotal}
              </td>
              {hourTotals.map((v, h) => (
                <td
                  key={h}
                  className="text-center text-text-secondary tabular-nums py-1"
                >
                  {v > 0 ? compactCurrency(v, locale) : ""}
                </td>
              ))}
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center gap-2 text-[10px] text-text-secondary">
        <span>{t.legendLess}</span>
        <div className="flex">
          {[0.1, 0.25, 0.5, 0.75, 1].map((intensity) => (
            <span
              key={intensity}
              className="w-4 h-3"
              style={{ backgroundColor: heatColor(intensity) }}
            />
          ))}
        </div>
        <span>{t.legendMore}</span>
      </div>
    </ReportShell>
  );
}

function HeatCell({
  cell,
  max,
  day,
  hour,
  locale,
  tooltipTemplate,
}: {
  cell: HeatmapCell | null;
  max: number;
  day: string;
  hour: number;
  locale: "ar" | "en";
  tooltipTemplate: string;
}) {
  const intensity = cell && max > 0 ? Math.max(0.06, cell.revenue / max) : 0;
  const bg = intensity === 0 ? "#f6f6fa" : heatColor(intensity);
  const revenue = cell?.revenue ?? 0;
  const count = cell?.count ?? 0;
  const title = tooltipTemplate
    .replace("{day}", day)
    .replace("{hour}", `${String(hour).padStart(2, "0")}:00`)
    .replace("{revenue}", formatCurrency(revenue, locale))
    .replace("{count}", String(count));
  return (
    <td className="p-0.5" title={title}>
      <div
        className="w-full h-4 rounded-[3px]"
        style={{ backgroundColor: bg }}
      />
    </td>
  );
}

// Colour ramp — mixes the brand accent into white by the given intensity.
function heatColor(intensity: number): string {
  const t = Math.max(0, Math.min(1, intensity));
  // Base: near-white → accent (#1203E3). Interpolate in sRGB — fine for this scale.
  const r = Math.round(240 - (240 - 18) * t);
  const g = Math.round(240 - (240 - 3) * t);
  const b = Math.round(250 - (250 - 227) * t);
  return `rgb(${r},${g},${b})`;
}

function compactCurrency(value: number, locale: "ar" | "en"): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
  return new Intl.NumberFormat(locale === "en" ? "en-EG" : "ar-EG", {
    maximumFractionDigits: 0,
    numberingSystem: "latn",
  } as Intl.NumberFormatOptions).format(value);
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
