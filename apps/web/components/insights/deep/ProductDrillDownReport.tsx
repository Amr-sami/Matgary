"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend,
} from "recharts";
import { formatCurrency } from "@/lib/i18n/format";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { Search, X } from "@/lib/icons";
import { UserText } from "@/components/ui/UserText";
import { useDeepFetch } from "./useDeepFetch";
import type { DeepReportProps } from "./types";

// Product picker (top-selling in the window as a default, or the search
// results) → per-day revenue + units chart, plus totals + margin.

interface ProductHit {
  id: string;
  name: string;
  brand: string | null;
  totalRevenue: number;
  unitsSold: number;
}

interface ProductSearchResponse {
  report: "product-search";
  hits: ProductHit[];
}

interface ProductDrillDownResponse {
  report: "product";
  productId: string;
  productName: string;
  brand: string | null;
  totals: {
    revenue: number;
    cost: number;
    grossProfit: number;
    margin: number;
    unitsSold: number;
    transactions: number;
    aov: number;
  };
  daily: Array<{ date: string; revenue: number; units: number }>;
}

export function ProductDrillDownReport({
  window,
  branchScope,
  locale,
}: DeepReportProps) {
  const dict = useDictionary();
  const t = dict.app.insights.deep.product;
  const [productId, setProductId] = useState<string | null>(null);
  const [productLabel, setProductLabel] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => clearTimeout(id);
  }, [query]);

  // Fetch the search hits any time the picker is shown OR the query changes.
  // When productId is null we always want the picker visible.
  const search = useDeepFetch<ProductSearchResponse>({
    report: "product-search",
    window,
    branchScope,
    extra: { q: debouncedQuery || undefined },
    enabled: !productId,
  });

  const drill = useDeepFetch<ProductDrillDownResponse>({
    report: "product",
    window,
    branchScope,
    extra: { productId: productId ?? undefined },
    enabled: !!productId,
  });

  const clearProduct = () => {
    setProductId(null);
    setProductLabel(null);
  };

  const summaryTiles = useMemo(() => {
    if (!drill.data) return null;
    const { totals } = drill.data;
    return [
      {
        label: t.metric.revenue,
        value: formatCurrency(totals.revenue, locale),
      },
      {
        label: t.metric.units,
        value: new Intl.NumberFormat(
          locale === "en" ? "en-EG" : "ar-EG",
          {
            maximumFractionDigits: 0,
            numberingSystem: "latn",
          } as Intl.NumberFormatOptions,
        ).format(totals.unitsSold),
      },
      {
        label: t.metric.transactions,
        value: String(totals.transactions),
      },
      {
        label: t.metric.aov,
        value: formatCurrency(totals.aov, locale),
      },
      {
        label: t.metric.gross,
        value: formatCurrency(totals.grossProfit, locale),
        tone: totals.grossProfit >= 0 ? "success" : "danger",
      },
      {
        label: t.metric.margin,
        value: `${totals.margin.toFixed(1)}%`,
        tone: totals.margin >= 0 ? undefined : "danger",
      },
    ] as Array<{
      label: string;
      value: string;
      tone?: "success" | "danger";
    }>;
  }, [drill.data, locale, t]);

  return (
    <ReportShell title={t.title} subtitle={t.subtitle}>
      {!productId ? (
        <>
          <label className="block relative mb-3">
            <Search className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.searchPlaceholder}
              className="w-full ps-9 pe-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:border-accent"
            />
          </label>
          {search.loading && !search.data ? (
            <div className="h-40 animate-pulse bg-bg-main/60 rounded-lg" />
          ) : search.data && search.data.hits.length > 0 ? (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {search.data.hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setProductId(hit.id);
                      setProductLabel(hit.name);
                    }}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-start hover:bg-bg-main/50 transition-colors"
                  >
                    <div className="min-w-0">
                      <p
                        className="text-sm font-medium text-text-primary truncate"
                        dir="auto"
                      >
                        <UserText>{hit.name}</UserText>
                      </p>
                      {hit.brand && (
                        <p className="text-xs text-text-secondary truncate">
                          <UserText>{hit.brand}</UserText>
                        </p>
                      )}
                    </div>
                    <div className="text-end shrink-0">
                      <p className="text-sm font-semibold tabular-nums text-text-primary">
                        {formatCurrency(hit.totalRevenue, locale)}
                      </p>
                      <p className="text-[11px] text-text-secondary">
                        {t.unitsSold.replace(
                          "{n}",
                          String(hit.unitsSold),
                        )}
                      </p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyHint text={t.noMatches} />
          )}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 mb-4">
            <div className="min-w-0">
              <p className="text-xs text-text-secondary">{t.viewingLabel}</p>
              <p
                className="text-base font-semibold text-text-primary truncate"
                dir="auto"
              >
                <UserText>{productLabel ?? "—"}</UserText>
              </p>
            </div>
            <button
              type="button"
              onClick={clearProduct}
              className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-accent px-2 py-1 rounded-md"
            >
              <X className="w-3.5 h-3.5" />
              {t.changeProduct}
            </button>
          </div>

          {drill.loading && !drill.data ? (
            <div className="h-72 animate-pulse bg-bg-main/60 rounded-lg" />
          ) : drill.error ? (
            <EmptyHint text={drill.error} tone="danger" />
          ) : !drill.data || drill.data.daily.length === 0 ? (
            <EmptyHint text={t.emptyDaily} />
          ) : (
            <>
              {summaryTiles && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
                  {summaryTiles.map((tile) => (
                    <div
                      key={tile.label}
                      className="rounded-lg border border-border bg-white p-3"
                    >
                      <p className="text-[10px] uppercase tracking-wider text-text-secondary">
                        {tile.label}
                      </p>
                      <p
                        className={`text-sm font-bold mt-0.5 tabular-nums ${
                          tile.tone === "success"
                            ? "text-success"
                            : tile.tone === "danger"
                              ? "text-danger"
                              : "text-text-primary"
                        }`}
                      >
                        {tile.value}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="h-64 bg-white rounded-lg border border-border p-3">
                  <p className="text-xs font-medium text-text-secondary mb-1">
                    {t.chart.revenue}
                  </p>
                  <ResponsiveContainer width="100%" height="90%">
                    <AreaChart
                      data={drill.data.daily}
                      margin={{ top: 4, right: 8, bottom: 4, left: 0 }}
                    >
                      <defs>
                        <linearGradient id="prodRev" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#1203E3" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="#1203E3" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#666" }} />
                      <YAxis
                        tick={{ fontSize: 10, fill: "#666" }}
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
                      <Area
                        type="monotone"
                        dataKey="revenue"
                        stroke="#1203E3"
                        strokeWidth={2}
                        fill="url(#prodRev)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="h-64 bg-white rounded-lg border border-border p-3">
                  <p className="text-xs font-medium text-text-secondary mb-1">
                    {t.chart.units}
                  </p>
                  <ResponsiveContainer width="100%" height="90%">
                    <BarChart
                      data={drill.data.daily}
                      margin={{ top: 4, right: 8, bottom: 4, left: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: "#666" }}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: "#666" }}
                        allowDecimals={false}
                      />
                      <Tooltip
                        contentStyle={{
                          borderRadius: 8,
                          border: "1px solid #eaeaea",
                          fontSize: 12,
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar
                        dataKey="units"
                        name={t.chart.units}
                        fill="#22C55E"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </>
          )}
        </>
      )}
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
      className={`h-40 rounded-lg border border-dashed flex items-center justify-center text-sm ${
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
