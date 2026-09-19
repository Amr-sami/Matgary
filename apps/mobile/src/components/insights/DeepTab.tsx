import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { branches as branchesApi } from "@matgary/api-client";

import { api } from "@/api/client";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import { compact, countLabel, dayMonth, money } from "@/lib/format";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, MIN_TOUCH, radius, spacing } from "@/theme/tokens";
import { t, useLocale } from "@/i18n";

/**
 * Port of apps/web/components/insights/deep/DeepDive.tsx — the "تحليل معمّق"
 * tab. Same five reports, same `/api/insights/deep?report=…` endpoint; the
 * charts are plain Views (bars / heat cells) so no new chart dependency.
 *
 * Branch scope (doc 02 §2.9 "owner-only branch-scope toggle survives"): an
 * owner of a multi-branch tenant gets a chip row "All branches / <branch>…"
 * above the reports. It sends `branchId=all|<uuid>` on every deep query, the
 * same param web's useDeepFetch sets, and the scope is part of every query
 * key. Staff and single-branch tenants see no row and the query carries no
 * `branchId`, so the server keeps defaulting to the caller's active branch.
 */

export type InsightsRange = "all" | "today" | "yesterday" | "7d" | "30d";

interface TabProps {
  /** `insights?tab=deep&report=heatmap` opens straight on a report. */
  initialReport?: string;
  /**
   * `insights?tab=deep&branchId=all|<uuid>` opens on a scope. Only honoured
   * when the chip row is shown (owner, >1 active branch); otherwise ignored, so a
   * link cannot make a cashier's request 403.
   */
  initialBranchId?: string;
  range: InsightsRange;
  from?: string;
  to?: string;
}

/**
 * `"all"` or a branch uuid — the value web's useDeepFetch puts in `branchId`.
 * `undefined` = omit the param (server falls back to the active branch).
 */
type BranchScope = string | undefined;

/** What DeepTab hands each report: the screen's props plus the resolved scope. */
type ReportProps = TabProps & { branchId: BranchScope };

type ReportKey = "compare" | "heatmap" | "payments" | "branches" | "product";
const isReportKey = (v: unknown): v is ReportKey =>
  v === "compare" || v === "heatmap" || v === "payments" || v === "branches" || v === "product";

const REPORTS = (): { key: ReportKey; label: string; hint: string }[] => ([
  { key: "compare", label: t("app.insights.deep.picker.compare.label"), hint: t("app.insights.deep.picker.compare.hint") },
  { key: "heatmap", label: t("app.insights.deep.picker.heatmap.label"), hint: t("app.insights.deep.picker.heatmap.hint") },
  { key: "payments", label: t("app.insights.deep.picker.payments.label"), hint: t("app.insights.deep.picker.payments.hint") },
  { key: "branches", label: t("app.insights.deep.picker.branches.label"), hint: t("app.insights.deep.picker.branches.hint") },
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
  { range, from, to, branchId }: ReportProps,
  extra?: Record<string, string | undefined>,
  enabled = true,
) {
  const hasWindow = Boolean(from && to);
  return useQuery({
    // range AND branch scope are part of the KEY so a chip tap refetches
    // instead of serving the previous window's / branch's figures from cache
    // (same rule as the overview).
    queryKey: ["insights-deep", report, range, from ?? null, to ?? null, branchId ?? null, extra ?? null],
    queryFn: () =>
      api.request<T>("/api/insights/deep", {
        query: {
          report,
          from: hasWindow ? from : undefined,
          to: hasWindow ? to : undefined,
          // Same param web's useDeepFetch sets: "all" | <uuid>, or omitted.
          branchId,
          ...(extra ?? {}),
        },
      }),
    enabled,
  });
}

/**
 * Owner-only management list (GET /api/branches). Shares the cache entry
 * settings/branches.tsx already keeps under ["branches"] — same endpoint,
 * same `data` array — so a rename or a new branch made there shows up here
 * without a second fetch. Suspended branches stay in: their history is
 * still worth a report.
 */
function useBranchList(enabled: boolean) {
  return useQuery({
    queryKey: ["branches"],
    queryFn: () => branchesApi.list(api).then((r) => r.data ?? []),
    enabled,
  });
}

export function DeepTab(props: TabProps) {
  const isOwner = useSession((s) => s.me?.isOwner ?? false);
  const activeBranchId = useSession((s) => s.me?.branch.id ?? null);
  const sessionBranches = useSession((s) => s.me?.branches);
  const [report, setReport] = useState<ReportKey>(
    isReportKey(props.initialReport) ? props.initialReport : "compare",
  );
  useEffect(() => {
    if (isReportKey(props.initialReport)) setReport(props.initialReport);
  }, [props.initialReport]);
  const active = REPORTS().find((r) => r.key === report);

  // ---- branch scope -------------------------------------------------------
  // `picked` is only what the user (or a deep link) chose; until then the
  // scope follows the active branch, so a switch elsewhere is reflected here.
  const branchList = useBranchList(isOwner);
  // /me already carries the switchable branches, so the row does not wait on
  // (or vanish with) the extra GET — same fallback settings/branches.tsx uses.
  // /me lists ACTIVE branches only; the GET adds suspended ones, sorted to the
  // tail so the active chips keep their slot when it lands.
  const branchRows = useMemo(() => {
    const rows = branchList.data
      ? branchList.data.map((b) => ({ id: b.id, name: b.name, isActive: b.isActive }))
      : (sessionBranches ?? []).map((b) => ({ id: b.id, name: b.name, isActive: true }));
    return [...rows.filter((b) => b.isActive), ...rows.filter((b) => !b.isActive)];
  }, [branchList.data, sessionBranches]);
  // Gate on the ACTIVE count, which both sources agree on. Counting suspended
  // rows too would let the row pop in (and re-key every deep query, refetching
  // identical data) the moment the GET returns for an owner with one live
  // branch plus suspended ones.
  const activeBranchCount = branchRows.filter((b) => b.isActive).length;
  const showScope = isOwner && activeBranchCount > 1;
  const [picked, setPicked] = useState<string | null>(props.initialBranchId ?? null);
  useEffect(() => {
    if (props.initialBranchId) setPicked(props.initialBranchId);
  }, [props.initialBranchId]);
  const pickedIsValid =
    picked === "all" || (picked != null && branchRows.some((b) => b.id === picked));
  const scope: BranchScope = !showScope
    ? undefined
    : pickedIsValid
      ? (picked as string)
      : (activeBranchId ?? "all");
  // Branch comparison is the one report that only makes sense across every
  // branch — the server ignores `branchId` for it and web forces "all". The
  // row stays put (no layout jump) but is dimmed with "All branches" lit so
  // the chips never claim a scope the report is not showing.
  const scopeLocked = report === "branches";
  const branchId: BranchScope = scopeLocked && showScope ? "all" : scope;
  const reportProps: ReportProps = { ...props, branchId };

  return (
    <>
      {showScope ? (
        <View
          pointerEvents={scopeLocked ? "none" : "auto"}
          accessibilityState={scopeLocked ? { disabled: true } : undefined}
          style={[styles.scope, scopeLocked && styles.chipLocked]}
        >
          <Text style={styles.scopeLabel}>{t("app.insights.scope.label")}</Text>
          <View style={styles.chipRow}>
            <Chip
              label={t("app.insights.scope.all")}
              active={branchId === "all"}
              onPress={() => setPicked("all")}
            />
            {branchRows.map((b) => (
              <Chip
                key={b.id}
                // A suspended branch is still worth a report (its history is
                // real), but the chip must say so — settings/branches.tsx badges
                // these rows and a plain name here would read as live.
                label={
                  b.isActive
                    ? b.name
                    : `${b.name} · ${t("app.branchesPage.labels.suspended")}`
                }
                active={branchId === b.id}
                onPress={() => setPicked(b.id)}
              />
            ))}
          </View>
        </View>
      ) : null}

      <View style={styles.scope}>
        <Text style={styles.scopeLabel}>{t("app.insights.deep.picker.label")}</Text>
        <View style={styles.chipRow}>
          {REPORTS().map((r) => {
            // Web greys out the "Branch comparison" card for non-owners instead
            // of revealing the gate after a tap. Chip has no disabled prop, so
            // the wrapper swallows touches; it can never become `active`, hence
            // no hint swap is needed here.
            const locked = r.key === "branches" && !isOwner;
            return (
              <View
                key={r.key}
                pointerEvents={locked ? "none" : "auto"}
                accessibilityState={locked ? { disabled: true } : undefined}
                accessibilityHint={locked ? t("app.insights.deep.picker.branches.ownerOnly") : undefined}
                style={locked && styles.chipLocked}
              >
                <Chip label={r.label} active={report === r.key} onPress={() => setReport(r.key)} />
              </View>
            );
          })}
        </View>
        {active ? <Text style={styles.hint}>{active.hint}</Text> : null}
      </View>

      {report === "compare" ? <CompareReport {...reportProps} /> : null}
      {report === "heatmap" ? <HeatmapReport {...reportProps} /> : null}
      {report === "payments" ? <PaymentsReport {...reportProps} /> : null}
      {report === "branches" ? <BranchesReport {...reportProps} isOwner={isOwner} /> : null}
      {report === "product" ? <ProductReport {...reportProps} /> : null}
    </>
  );
}

/* ---------------------------------------------------------------- shared */

function Loading() {
  return <ActivityIndicator color={colors.accent} style={{ marginVertical: spacing.xl }} />;
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
  if (q.isLoading) return <Loading />;
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

  if (q.isLoading) return <Loading />;
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

type Method = "cash" | "instapay" | "card" | "deferred" | "unknown";

interface PaymentsData {
  methods: string[];
  series: ({ label: string; day: string; total: number } & Record<string, number | string>)[];
}

const METHOD_COLOR: Record<Method, string> = {
  cash: colors.accent,
  instapay: colors.success,
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

  if (q.isLoading) return <Loading />;
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
        </>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------- branches */

interface BranchesData {
  rows: {
    branchId: string;
    branchName: string;
    revenue: number;
    cost: number;
    discounts: number;
    grossProfit: number;
    transactions: number;
    aov: number;
    margin: number;
  }[];
}

function BranchesReport(props: ReportProps & { isOwner: boolean }) {
  const q = useDeep<BranchesData>("branches", props, undefined, props.isOwner);

  if (!props.isOwner) {
    return (
      <Card title={t("app.insights.deep.branches.title")}>
        <Text style={styles.muted}>{t("app.insights.deep.branches.ownerOnly")}</Text>
      </Card>
    );
  }
  if (q.isLoading) return <Loading />;
  if (!q.data) return <Failed />;

  const rows = q.data.rows;
  const max = Math.max(1, ...rows.map((r) => r.revenue));

  return (
    <Card title={t("app.insights.deep.branches.title")}>
      <Subtitle>{t("app.insights.deep.branches.subtitle")}</Subtitle>
      {rows.length === 0 ? (
        <EmptyState title={t("app.insights.deep.branches.empty")} />
      ) : (
        <View style={styles.list}>
          {rows.map((r) => (
            <View key={r.branchId} style={styles.rowCard}>
              <View style={styles.rowHead}>
                <Text numberOfLines={1} style={styles.rowTitle}>{r.branchName}</Text>
                <Text style={styles.rowValue}>{money(r.revenue)}</Text>
              </View>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${(r.revenue / max) * 100}%` }]} />
              </View>
              <View style={styles.metricGrid}>
                <Metric label={t("app.insights.deep.branches.col.transactions")} value={String(r.transactions)} />
                <Metric label={t("app.insights.deep.branches.col.aov")} value={money(r.aov)} />
                <Metric label={t("app.insights.deep.branches.col.gross")} value={money(r.grossProfit)} />
                <Metric label={t("app.insights.deep.branches.col.margin")} value={percent(r.margin)} />
                <Metric label={t("app.insights.deep.branches.col.discounts")} value={money(r.discounts)} />
              </View>
            </View>
          ))}
        </View>
      )}
    </Card>
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
          {search.isLoading ? (
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
        detail.isLoading ? (
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
  chipLocked: { opacity: 0.45 },
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
