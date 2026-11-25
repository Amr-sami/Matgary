import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/api/client";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import { SkeletonChart, SkeletonListRow } from "@/components/ui/skeleton";
import { compact, countLabel, dayMonth, money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, MIN_TOUCH, radius, spacing } from "@/theme/tokens";
import { t, useLocale } from "@/i18n";

/**
 * Port of apps/web/components/insights/deep/DeepDive.tsx — the "تحليل معمّق"
 * tab. Same reports, same `/api/insights/deep?report=…` endpoint; the
 * charts are plain Views (bars / heat cells) so no new chart dependency.
 */

export type InsightsRange = "all" | "today" | "yesterday" | "7d" | "30d";

interface TabProps {
  /** `insights?tab=deep&report=heatmap` opens straight on a report. */
  initialReport?: string;
  range: InsightsRange;
  from?: string;
  to?: string;
}

type ReportProps = TabProps;

type ReportKey = "compare" | "heatmap" | "payments" | "product";
const isReportKey = (v: unknown): v is ReportKey =>
  v === "compare" || v === "heatmap" || v === "payments" || v === "product";

const REPORTS = (): { key: ReportKey; label: string; hint: string }[] => ([
  { key: "compare", label: t("app.insights.deep.picker.compare.label"), hint: t("app.insights.deep.picker.compare.hint") },
  { key: "heatmap", label: t("app.insights.deep.picker.heatmap.label"), hint: t("app.insights.deep.picker.heatmap.hint") },
  { key: "payments", label: t("app.insights.deep.picker.payments.label"), hint: t("app.insights.deep.picker.payments.hint") },
  { key: "product", label: t("app.insights.deep.picker.product.label"), hint: t("app.insights.deep.picker.product.hint") },
]);

/**
 * "+12.5%" / "-3.0%" / "41.2%", isolated LTR (U+2066 … U+2069). The sign and
 * the "%" are bidi-neutral, so on an Arabic device a bare "+12.5%" resolves
 * against the RTL paragraph and paints as "12.5%+"; the isolate pins the run.
 * TODO: hoist into @/lib/format as percent() and route StatCard through it.
 */
function percent(n: number, opts?: { sign?: boolean; digits?: number }): string {
  const digits = opts?.digits ?? 1;
  const sign = opts?.sign && n >= 0 ? "+" : "";
  return `\u2066${sign}${n.toFixed(digits)}%\u2069`;
}

function useDeep<T>(
  report: string,
  { range, from, to }: ReportProps,
  extra?: Record<string, string | undefined>,
  enabled = true,
) {
  const hasWindow = Boolean(from && to);
  return useQuery({
    queryKey: ["insights-deep", report, range, from ?? null, to ?? null, extra ?? null],
    queryFn: () =>
      api.request<T>("/api/insights/deep", {
        query: {
          report,
          from: hasWindow ? from : undefined,
          to: hasWindow ? to : undefined,
          ...(extra ?? {}),
        },
      }),
    enabled,
  });
}

export function DeepTab(props: TabProps) {
  const [report, setReport] = useState<ReportKey>(
    isReportKey(props.initialReport) ? props.initialReport : "compare",
  );
  useEffect(() => {
    if (isReportKey(props.initialReport)) setReport(props.initialReport);
  }, [props.initialReport]);
  const active = REPORTS().find((r) => r.key === report);
  const reportProps: ReportProps = props;

  return (
    <>
      <View style={styles.scope}>
        <Text style={styles.scopeLabel}>{t("app.insights.deep.picker.label")}</Text>
        <View style={styles.chipRow}>
          {REPORTS().map((r) => (
            <Chip
              key={r.key}
              label={r.label}
              active={report === r.key}
              onPress={() => setReport(r.key)}
            />
          ))}
        </View>
        {active ? <Text style={styles.hint}>{active.hint}</Text> : null}
      </View>

      {report === "compare" ? <CompareReport {...reportProps} /> : null}
      {report === "heatmap" ? <HeatmapReport {...reportProps} /> : null}
      {report === "payments" ? <PaymentsReport {...reportProps} /> : null}
      {report === "product" ? <ProductReport {...reportProps} /> : null}
    </>
  );
}

/* ---------------------------------------------------------------- shared */

function Loading() {
  return (
    <Card>
      <SkeletonChart height={160} />
      <SkeletonListRow count={3} avatarSize={0} trailingWidth={56} height={44} />
    </Card>
  );
}

function Failed() {
  return (
    <Card>
      <Text style={styles.muted}>{t("mobile.insights.loadFailed")}</Text>
    </Card>
  );
}

function Subtitle({ children }: { children: string }) {
  return <Text style={styles.subtitle}>{children}</Text>;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text
        numberOfLines={1}
        style={[styles.statValue, tone === "up" && { color: colors.successStrong }, tone === "down" && { color: colors.danger }]}
      >
        {value}
      </Text>
    </View>
  );
}

function LegendDot({ color, opacity, label }: { color: string; opacity?: number; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.dot, { backgroundColor: color, opacity }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

/** Two axis labels under a bar chart — first and last bucket. */
function AxisEnds({ first, last }: { first?: string; last?: string }) {
  return (
    <View style={styles.axis}>
      <Text style={styles.axisText}>{first ?? ""}</Text>
      <Text style={styles.axisText}>{last ?? ""}</Text>
    </View>
  );
}

const BAR_H = 140;

/**
 * The comparison ("previous") series. accentLight (#E7E6FC) is ~1.15:1 on a
 * white card — invisible next to the accent bars. accent at 0.45 opacity
 * composites to ≈#948EF2, ≈3:1 on white: the same accent+opacity ramp the
 * heatmap cells use, so no extra hex enters the token set.
 */
const PREVIOUS_OPACITY = 0.45;

/* --------------------------------------------------------------- compare */

interface CompareData {
  points: { dayIndex: number; day: string; label: string; current: number; previous: number }[];
  totals: { current: number; previous: number; growth: number };
}

function CompareReport(props: ReportProps) {
  const hasWindow = Boolean(props.from && props.to);
  const q = useDeep<CompareData>("compare", props, undefined, hasWindow);

  if (!hasWindow) {
    return (
      <Card title={t("app.insights.deep.compare.title")}>
        <Text style={styles.muted}>{t("app.insights.deep.compare.needsWindow")}</Text>
      </Card>
    );
  }
  if (q.isPending && !q.data) return <Loading />;
  if (!q.data) return <Failed />;

  const { points, totals } = q.data;
  const max = Math.max(1, ...points.map((p) => Math.max(p.current, p.previous)));
  const empty = totals.current === 0 && totals.previous === 0;
  const up = totals.growth >= 0;

  return (
    <Card title={t("app.insights.deep.compare.title")}>
      {/* No Subtitle: the picker hint directly above already says what this
          report is; the same sentence twice, 60pt apart, read as filler. */}
      <View style={styles.statRow}>
        <Stat label={t("app.insights.deep.compare.currentTotal")} value={money(totals.current)} />
        <View style={styles.statDivider} />
        <Stat label={t("app.insights.deep.compare.previousTotal")} value={money(totals.previous)} />
        <View style={styles.statDivider} />
        <Stat
          label={t("app.insights.deep.compare.growth")}
          value={percent(totals.growth, { sign: true })}
          tone={up ? "up" : "down"}
        />
      </View>
      {empty ? (
        <EmptyState title={t("app.insights.deep.compare.empty")} />
      ) : (
        <>
          <View style={styles.bars}>
            {points.map((p) => (
              <View key={p.dayIndex} style={styles.barGroup}>
                <View style={[styles.bar, { height: Math.max(2, (p.previous / max) * BAR_H), backgroundColor: colors.accent, opacity: PREVIOUS_OPACITY }]} />
                <View style={[styles.bar, { height: Math.max(2, (p.current / max) * BAR_H), backgroundColor: colors.accent }]} />
              </View>
            ))}
          </View>
          <AxisEnds first={dayMonth(points[0]?.day)} last={dayMonth(points[points.length - 1]?.day)} />
          <View style={styles.legend}>
            <LegendDot color={colors.accent} label={t("app.insights.deep.compare.legend.current")} />
            <LegendDot color={colors.accent} opacity={PREVIOUS_OPACITY} label={t("app.insights.deep.compare.legend.previous")} />
          </View>
        </>
      )}
    </Card>
  );
}

/* --------------------------------------------------------------- heatmap */

interface HeatmapData {
  cells: { dow: number; hour: number; revenue: number; count: number }[];
  peak?: { dow: number; hour: number; revenue: number } | null;
}

const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
/** Hours that get a printed label on the heatmap axis. */
const HOUR_TICKS = new Set([0, 6, 12, 18, 23]);

function HeatmapReport(props: ReportProps) {
  const q = useDeep<HeatmapData>("heatmap", props);

  const model = useMemo(() => {
    const cells = q.data?.cells ?? [];
    const grid: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    const dayTotals = new Array<number>(7).fill(0);
    const hourTotals = new Array<number>(24).fill(0);
    let max = 0;
    let peak: { dow: number; hour: number; revenue: number } | null = null;
    for (const c of cells) {
      if (c.dow < 0 || c.dow > 6 || c.hour < 0 || c.hour > 23) continue;
      grid[c.dow]![c.hour] = c.revenue;
      dayTotals[c.dow]! += c.revenue;
      hourTotals[c.hour]! += c.revenue;
      if (c.revenue > max) max = c.revenue;
      if (!peak || c.revenue > peak.revenue) peak = { dow: c.dow, hour: c.hour, revenue: c.revenue };
    }
    const maxHour = Math.max(1, ...hourTotals);
    const grand = dayTotals.reduce((a, b) => a + b, 0);
    return { grid, dayTotals, hourTotals, maxHour, grand, max, peak: q.data?.peak ?? peak, empty: cells.length === 0 };
  }, [q.data]);

  if (q.isPending && !q.data) return <Loading />;
  if (!q.data) return <Failed />;

  return (
    <Card title={t("app.insights.deep.heatmap.title")}>
      <Subtitle>{t("app.insights.deep.heatmap.subtitle")}</Subtitle>
      {model.empty ? (
        <EmptyState title={t("app.insights.deep.heatmap.empty")} />
      ) : (
        <>
          {model.peak ? (
            <Text style={styles.peak}>
              {t("app.insights.deep.heatmap.peakLine", {
                day: t(`mobile.insights.dow.${DOW_KEYS[model.peak.dow]}`),
                hour: String(model.peak.hour).padStart(2, "0"),
                revenue: money(model.peak.revenue),
              })}
            </Text>
          ) : null}
          <View style={styles.heat}>
            {/* Hour axis sits ABOVE the grid: the report opens mid-screen and
                the footer + legend push anything below the rows under the
                tab bar, so a trailing axis was never visible on first paint. */}
            <View style={[styles.heatRow, styles.heatHeader]}>
              <View style={styles.heatDaySpacer} />
              {/* One flex:1 slot per hour, mirroring heatCells (same gap), so
                  each printed label is centred on the column it names —
                  space-between put "18" over hour 17. The label is wider than
                  its slot and overflows symmetrically into the neighbours. */}
              <View style={styles.heatHours}>
                {model.hourTotals.map((_, h) => (
                  <View key={h} style={styles.heatHourSlot}>
                    {HOUR_TICKS.has(h) ? (
                      <Text style={[styles.axisText, styles.heatHourLabel]}>{String(h).padStart(2, "0")}</Text>
                    ) : null}
                  </View>
                ))}
              </View>
              <View style={styles.heatTotal}>
                <Text numberOfLines={1} style={styles.heatTotalText}>
                  {t("mobile.insights.heatmap.footerLabel")}
                </Text>
              </View>
            </View>
            {model.grid.map((row, dow) => (
              <View key={dow} style={styles.heatRow}>
                <Text numberOfLines={1} style={styles.heatDay}>
                  {t(`mobile.insights.dow.${DOW_KEYS[dow]}`)}
                </Text>
                <View style={styles.heatCells}>
                  {row.map((rev, hour) => (
                    <View
                      key={hour}
                      style={[
                        styles.heatCell,
                        rev > 0
                          ? { backgroundColor: colors.accent, opacity: 0.12 + 0.88 * (rev / Math.max(1, model.max)) }
                          : { backgroundColor: colors.neutralTint },
                      ]}
                    />
                  ))}
                </View>
                <View style={styles.heatTotal}>
                  <Text numberOfLines={1} style={styles.heatTotalText}>
                    {model.dayTotals[dow] ? compact(model.dayTotals[dow]!) : ""}
                  </Text>
                </View>
              </View>
            ))}
            {/* Web's per-hour totals footer. 24 digit columns do not fit at
                390pt, so the footer is a heat strip (shade = hour total) with
                the grand total in the trailing slot — "which hour is busiest
                overall" survives, the exact figures do not. */}
            <View style={[styles.heatRow, styles.heatFooter]}>
              <Text numberOfLines={1} style={styles.heatDay}>
                {t("mobile.insights.heatmap.footerLabel")}
              </Text>
              <View style={styles.heatCells}>
                {model.hourTotals.map((total, hour) => (
                  <View
                    key={hour}
                    style={[
                      styles.heatCell,
                      total > 0
                        ? { backgroundColor: colors.accent, opacity: 0.12 + 0.88 * (total / model.maxHour) }
                        : { backgroundColor: colors.neutralTint },
                    ]}
                  />
                ))}
              </View>
              <View style={styles.heatTotal}>
                <Text numberOfLines={1} style={styles.heatTotalText}>
                  {model.grand ? compact(model.grand) : ""}
                </Text>
              </View>
            </View>
          </View>
          <View style={styles.legend}>
            <Text style={styles.legendText}>{t("app.insights.deep.heatmap.legendLess")}</Text>
            {[0.12, 0.34, 0.56, 0.78, 1].map((o) => (
              <View key={o} style={[styles.ramp, { backgroundColor: colors.accent, opacity: o }]} />
            ))}
            <Text style={styles.legendText}>{t("app.insights.deep.heatmap.legendMore")}</Text>
          </View>
        </>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------- payments */

type Method = "cash" | "instapay" | "wallet" | "card" | "deferred" | "unknown";

interface CollectionsSplitBucket {
  confirmed: number;
  autoConfirmed: number;
  pending: number;
  rejectedDebt: number;
  rejectedLoss: number;
}

interface PaymentsData {
  methods: string[];
  series: ({ label: string; day: string; total: number } & Record<string, number | string>)[];
  /** Doc 15 spec 13 §4.11 — absent on an old server, null when Collections is off. */
  collections?: {
    byMethod: Record<"instapay" | "wallet", CollectionsSplitBucket>;
    cashRemainder: number;
    unverified: number;
  } | null;
}

const METHOD_COLOR: Record<Method, string> = {
  cash: colors.accent,
  instapay: colors.success,
  wallet: colors.successStrong,
  card: colors.warning,
  deferred: colors.danger,
  unknown: colors.textSecondary,
};

function methodColor(m: string): string {
  return METHOD_COLOR[(m in METHOD_COLOR ? m : "unknown") as Method];
}
function methodLabel(m: string): string {
  return t(`app.insights.deep.payments.methods.${m in METHOD_COLOR ? m : "unknown"}`);
}

function PaymentsReport(props: ReportProps) {
  const q = useDeep<PaymentsData>("payments", props);
  // Digits are an LTR run in both locales, so the ones column sits at the
  // PHYSICAL right of every amount: the reading start in Arabic ("1,234 ج.م"),
  // the reading end in English ("EGP 1,234"). Read at render time — a
  // StyleSheet value is fixed at import (see theme/rtl.ts).
  const rtl = useLocale((s) => s.locale) === "ar";
  const valueAlign = { alignItems: rtl ? ("flex-start" as const) : ("flex-end" as const) };

  const model = useMemo(() => {
    const methods = q.data?.methods ?? [];
    const series = q.data?.series ?? [];
    const totals = methods.map((m) => ({
      method: m,
      total: series.reduce((s, d) => s + Number(d[m] ?? 0), 0),
    }));
    const grand = totals.reduce((s, x) => s + x.total, 0);
    const max = Math.max(1, ...series.map((d) => d.total));
    return { methods, series, totals, grand, max };
  }, [q.data]);

  if (q.isPending && !q.data) return <Loading />;
  if (!q.data) return <Failed />;

  return (
    <Card title={t("app.insights.deep.payments.title")}>
      <Subtitle>{t("app.insights.deep.payments.subtitle")}</Subtitle>
      {model.series.length === 0 ? (
        <EmptyState title={t("app.insights.deep.payments.empty")} />
      ) : (
        <>
          <View style={styles.list}>
            {model.totals.map((x) => (
              <View key={x.method} style={styles.methodRow}>
                <View style={[styles.dot, { backgroundColor: methodColor(x.method) }]} />
                <Text style={styles.methodName}>{methodLabel(x.method)}</Text>
                <Text style={styles.methodShare}>
                  {model.grand ? percent((x.total / model.grand) * 100) : "—"}
                </Text>
                <View style={[styles.methodValue, valueAlign]}>
                  <Text style={styles.methodValueText}>{money(x.total)}</Text>
                </View>
              </View>
            ))}
          </View>
          <View style={styles.bars}>
            {model.series.map((d) => (
              <View key={d.day} style={styles.stack}>
                {model.methods.map((m) => {
                  const v = Number(d[m] ?? 0);
                  if (v <= 0) return null;
                  return (
                    <View
                      key={m}
                      style={{ width: "100%", height: (v / model.max) * BAR_H, backgroundColor: methodColor(m) }}
                    />
                  );
                })}
              </View>
            ))}
          </View>
          <AxisEnds first={dayMonth(model.series[0]?.day)} last={dayMonth(model.series[model.series.length - 1]?.day)} />
          {q.data.collections ? (
            <CollectionsStrip split={q.data.collections} valueAlign={valueAlign} />
          ) : null}
        </>
      )}
    </Card>
  );
}

/**
 * The "digital Z" strip under the payments chart (13 §4.11): transfer money
 * by verification state, both digital methods summed; confirmed includes
 * auto-confirmed. Same five cells as the web strip.
 */
function CollectionsStrip({
  split,
  valueAlign,
}: {
  split: NonNullable<PaymentsData["collections"]>;
  valueAlign: { alignItems: "flex-start" | "flex-end" };
}) {
  const both = (k: keyof CollectionsSplitBucket) =>
    Number(split.byMethod.instapay?.[k] ?? 0) + Number(split.byMethod.wallet?.[k] ?? 0);
  const cells: { key: string; label: string; value: number; color: string }[] = [
    {
      key: "confirmed",
      label: t("app.insights.deep.payments.collectionConfirmed"),
      value: both("confirmed") + both("autoConfirmed"),
      color: colors.successStrong,
    },
    { key: "pending", label: t("app.insights.deep.payments.collectionPending"), value: both("pending"), color: colors.warningStrong },
    { key: "rejectedDebt", label: t("app.insights.deep.payments.collectionRejectedDebt"), value: both("rejectedDebt"), color: colors.danger },
    { key: "rejectedLoss", label: t("app.insights.deep.payments.collectionRejectedLoss"), value: both("rejectedLoss"), color: colors.danger },
    {
      key: "cashRemainder",
      label: t("app.insights.deep.payments.collectionCashRemainder"),
      value: Number(split.cashRemainder ?? 0),
      color: colors.textSecondary,
    },
  ];
  return (
    <View testID="insights-payments-collections" collapsable={false} style={styles.collectionsStrip}>
      <Text style={styles.collectionsTitle}>{t("app.insights.deep.payments.collectionTitle")}</Text>
      <View style={styles.list}>
        {cells.map((c) => (
          <View key={c.key} style={styles.methodRow}>
            <View style={[styles.dot, { backgroundColor: c.color }]} />
            <Text style={styles.methodName}>{c.label}</Text>
            <View style={[styles.methodValue, valueAlign]}>
              <Text style={styles.methodValueText}>{money(c.value)}</Text>
            </View>
          </View>
        ))}
      </View>
      {Number(split.unverified ?? 0) > 0 ? (
        <Text style={styles.collectionsNote}>
          {t("app.insights.deep.payments.collectionUnverified", { amount: money(Number(split.unverified)) })}
        </Text>
      ) : null}
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.metricValue}>{value}</Text>
    </View>
  );
}

/* --------------------------------------------------------------- product */

interface ProductHit { id: string; name: string; brand: string | null; totalRevenue: number; unitsSold: number }

interface ProductData {
  productId: string;
  productName: string;
  brand: string | null;
  totals: { revenue: number; cost: number; grossProfit: number; margin: number; unitsSold: number; transactions: number; aov: number };
  daily: { date: string; revenue: number; units: number }[];
}

function ProductReport(props: ReportProps) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [picked, setPicked] = useState<ProductHit | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(id);
  }, [q]);

  const search = useDeep<{ hits: ProductHit[] }>("product-search", props, { q: debounced }, !picked);
  const detail = useDeep<ProductData>("product", props, { productId: picked?.id }, Boolean(picked));

  return (
    <Card title={picked ? undefined : t("mobile.insights.deep.product.pickTitle")}>
      {/* Not app.insights.deep.product.title: that is the exact text of the
          selected report chip ~100pt above. Before a pick the card asks for
          one; after it the viewing block below is the header. */}
      {picked ? (
        <View style={styles.viewing}>
          <Text style={styles.statLabel}>{t("app.insights.deep.product.viewingLabel")}</Text>
          <Text numberOfLines={1} style={styles.rowTitle}>
            {picked.name}{picked.brand ? ` · ${picked.brand}` : ""}
          </Text>
          <Pressable
            onPress={() => setPicked(null)}
            hitSlop={8}
            style={({ pressed }) => [styles.change, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.changeText}>{t("app.insights.deep.product.changeProduct")}</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <SearchField
            value={q}
            onChangeText={setQ}
            placeholder={t("app.insights.deep.product.searchPlaceholder")}
          />
          {search.isPending && !search.data ? (
            <Loading />
          ) : !search.data ? (
            <Text style={styles.muted}>{t("mobile.insights.loadFailed")}</Text>
          ) : search.data.hits.length === 0 ? (
            <EmptyState title={t("app.insights.deep.product.noMatches")} />
          ) : (
            <View style={styles.list}>
              {search.data.hits.map((h) => (
                <Pressable
                  key={h.id}
                  onPress={() => setPicked(h)}
                  style={({ pressed }) => [styles.hit, pressed && { backgroundColor: colors.accentLight }]}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={styles.rowTitle}>{h.name}</Text>
                    {/* Two Text nodes, not one joined string: a Latin brand
                        first would make iOS pick an LTR paragraph and park
                        "16" left of "قطعة". Count leads; the row order is the
                        reading order in both locales (StaffTab does the same). */}
                    <View style={styles.hitMeta}>
                      <Text style={styles.statLabel}>
                        {countLabel("mobile.common.pieces", h.unitsSold)}
                      </Text>
                      {h.brand ? (
                        <>
                          <Text style={styles.statLabel}>{"·"}</Text>
                          <Text numberOfLines={1} style={[styles.statLabel, styles.hitBrand]}>{h.brand}</Text>
                        </>
                      ) : null}
                    </View>
                  </View>
                  <Text style={styles.rowValue}>{money(h.totalRevenue)}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </>
      )}

      {picked ? (
        detail.isPending && !detail.data ? (
          <Loading />
        ) : !detail.data ? (
          <Text style={styles.muted}>{t("mobile.insights.loadFailed")}</Text>
        ) : (
          <ProductDetail data={detail.data} />
        )
      ) : null}
    </Card>
  );
}

function ProductDetail({ data }: { data: ProductData }) {
  const { totals, daily } = data;
  const max = Math.max(1, ...daily.map((d) => d.revenue));
  const maxUnits = Math.max(1, ...daily.map((d) => d.units));
  return (
    <>
      <View style={styles.metricGrid}>
        <Metric label={t("app.insights.deep.product.metric.revenue")} value={money(totals.revenue)} />
        <Metric label={t("app.insights.deep.product.metric.units")} value={String(totals.unitsSold)} />
        <Metric label={t("app.insights.deep.product.metric.transactions")} value={String(totals.transactions)} />
        <Metric label={t("app.insights.deep.product.metric.aov")} value={money(totals.aov)} />
        <Metric label={t("app.insights.deep.product.metric.gross")} value={money(totals.grossProfit)} />
        <Metric label={t("app.insights.deep.product.metric.margin")} value={percent(totals.margin)} />
      </View>
      {daily.length === 0 ? (
        <Text style={styles.muted}>{t("app.insights.deep.product.emptyDaily")}</Text>
      ) : (
        <>
          <Text style={styles.chartTitle}>{t("app.insights.deep.product.chart.revenue")}</Text>
          <View style={styles.bars}>
            {daily.map((d) => (
              <View key={d.date} style={styles.barGroup}>
                <View style={[styles.bar, { height: Math.max(2, (d.revenue / max) * BAR_H), backgroundColor: colors.accent }]} />
              </View>
            ))}
          </View>
          <AxisEnds first={dayMonth(daily[0]?.date)} last={dayMonth(daily[daily.length - 1]?.date)} />

          <Text style={styles.chartTitle}>{t("app.insights.deep.product.chart.units")}</Text>
          <View style={styles.bars}>
            {daily.map((d) => (
              <View key={d.date} style={styles.barGroup}>
                <View style={[styles.bar, { height: Math.max(2, (d.units / maxUnits) * BAR_H), backgroundColor: colors.success }]} />
              </View>
            ))}
          </View>
          <AxisEnds first={dayMonth(daily[0]?.date)} last={dayMonth(daily[daily.length - 1]?.date)} />
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  scope: { gap: spacing.xs },
  scopeLabel: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  // Inside the captioned group (gap xs) — xs + xs = the 8pt it always sat at.
  hint: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, marginTop: spacing.xs, ...RTL_TEXT },
  muted: { fontFamily: fonts.medium, fontSize: 15, color: colors.textSecondary, ...RTL_TEXT },
  subtitle: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, marginBottom: spacing.lg, ...RTL_TEXT },
  chartTitle: { fontFamily: fonts.semibold, fontSize: 14, color: colors.text, marginTop: spacing.lg, marginBottom: spacing.sm, ...RTL_TEXT },

  statRow: {
    flexDirection: "row",
    gap: spacing.md,
    paddingBottom: spacing.lg,
    marginBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  stat: { flex: 1, gap: 2 },
  // Same hairline the overview trend card puts between its three stats.
  statDivider: { width: 1, alignSelf: "stretch", backgroundColor: colors.border },
  statLabel: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  statValue: { fontFamily: fonts.bold, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"], ...RTL_TEXT },

  bars: { flexDirection: "row", alignItems: "flex-end", height: BAR_H, gap: 2, marginTop: spacing.sm },
  barGroup: { flex: 1, flexDirection: "row", alignItems: "flex-end", gap: 1 },
  bar: { flex: 1, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  stack: { flex: 1, flexDirection: "column-reverse", alignItems: "stretch" },
  axis: { flexDirection: "row", justifyContent: "space-between", marginTop: spacing.xs },
  axisText: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary, fontVariant: ["tabular-nums"] },

  legend: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.md, marginTop: spacing.md },
  legendItem: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  legendText: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  dot: { width: 10, height: 10, borderRadius: radius.full },
  ramp: { width: 14, height: 14, borderRadius: 3 },

  peak: { fontFamily: fonts.medium, fontSize: 13, color: colors.text, marginBottom: spacing.md, ...RTL_TEXT },
  heat: { gap: 2 },
  heatRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  heatDay: { ...RTL_TEXT, width: 44, fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary },
  heatDaySpacer: { width: 44 },
  heatCells: { flex: 1, flexDirection: "row", gap: 1 },
  heatCell: { flex: 1, aspectRatio: 1, borderRadius: 2 },
  // 24 slots with the cells' gap, so slot h sits exactly over column h.
  heatHours: { flex: 1, flexDirection: "row", gap: 1 },
  heatHourSlot: { flex: 1, alignItems: "center" },
  // Wider than the ~8pt slot on purpose; it overflows evenly to both sides.
  heatHourLabel: { width: 24, textAlign: "center" },
  // View + flex-end (not textAlign: "right"): Yoga resolves flex-end against
  // the inherited `direction`, so the digits hug the row edge in both locales.
  // 56pt fits "168.3 ألف" / "1.2 مليون" at 11pt without an ellipsis.
  heatTotal: { width: 56, alignItems: "flex-end" },
  heatTotalText: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary, fontVariant: ["tabular-nums"] },
  heatHeader: { marginBottom: spacing.xs },
  heatFooter: { marginTop: spacing.xs },

  list: { gap: spacing.sm },
  collectionsStrip: {
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: spacing.sm,
  },
  collectionsTitle: { fontFamily: fonts.semibold, fontSize: 14, color: colors.text, ...RTL_TEXT },
  collectionsNote: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  methodRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 28 },
  methodName: { flex: 1, fontFamily: fonts.medium, fontSize: 14, color: colors.text, ...RTL_TEXT },
  // Fixed width so the share column lines up across rows ("41.2%" / "8.0%").
  methodShare: { width: 48, ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, fontVariant: ["tabular-nums"] },
  // alignItems is set per render (PaymentsReport): the ones digit must align.
  methodValue: { minWidth: 90 },
  methodValueText: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 14, color: colors.text, fontVariant: ["tabular-nums"] },

  rowCard: { gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  rowTitle: { flex: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  rowValue: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"] },
  track: { height: 6, borderRadius: radius.full, backgroundColor: colors.neutralTint, overflow: "hidden" },
  fill: { height: "100%", borderRadius: radius.full, backgroundColor: colors.accent },
  metricGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.xs },
  metric: { width: "31%", flexGrow: 1, gap: 1 },
  metricValue: { fontFamily: fonts.semibold, fontSize: 14, color: colors.text, fontVariant: ["tabular-nums"], ...RTL_TEXT },

  viewing: { gap: 2, paddingBottom: spacing.md, marginBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  change: { alignSelf: "flex-start", minHeight: MIN_TOUCH, justifyContent: "center" },
  changeText: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 14, color: colors.accent },
  hit: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    // Cancel the padding so the text lines up with the card title and the
    // SearchField; the pressed highlight bleeds into the gutter instead.
    marginHorizontal: -spacing.sm,
    borderRadius: radius.md,
  },
  hitMeta: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  hitBrand: { flexShrink: 1 },
});
