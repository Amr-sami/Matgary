"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

interface OverviewPayload {
  kpis: {
    totalTenants: number;
    totalTenantsDeltaThisWeek: number;
    trialing: number;
    trialingExpiringIn7d: number;
    activePaid: number;
    activePaidDeltaThisWeek: number;
    mrrEgp: string;
    mrrDeltaThisWeekEgp: string;
    todaySignups: number;
    signupsLastWeekSameDay: number;
  };
  trialsExpiringSoon: {
    id: string;
    name: string;
    ownerEmail: string | null;
    trialEndsAt: string;
  }[];
  recentPaymentFailures: {
    tenantId: string;
    tenantName: string;
    amountEgp: string;
    failureReason: string | null;
    attemptedAt: string;
  }[];
  recentAdminActivity: {
    id: string;
    action: string;
    adminEmail: string | null;
    targetKind: string | null;
    targetId: string | null;
    occurredAt: string;
  }[];
  planDistribution: { plan: string; count: number }[];
  signupsLast30Days: { day: string; count: number }[];
  attention: {
    critical: { suspended: number; paymentFailures30d: number };
    atRisk: { highRiskStores: number };
    attention: { trialsExpiring7d: number; mediumRiskStores: number };
  };
  presence: {
    onlineNow: number;
    active5m: number;
    active15m: number;
    activeToday: number;
    dau: number;
    wau: number;
    mau: number;
    byPlatform: { ios: number; android: number; web: number; other: number };
  };
  devices: {
    activeDevicesNow: number;
    activeDevicesToday: number;
    installsToday: number;
    installsThisWeek: number;
    installsThisMonth: number;
    byPlatform: { ios: number; android: number; web: number; other: number };
    installsLast90d: { day: string; count: number }[];
    appVersionDistribution: {
      platform: string;
      appVersion: string;
      count: number;
    }[];
  };
  storeActivity: {
    activeToday: number;
    active7d: number;
    active30d: number;
    salesActiveToday: number;
    salesActive7d: number;
    salesActive30d: number;
    inactive7d: number;
    inactive14d: number;
    inactive30d: number;
    activityTrend30d: { day: string; stores: number }[];
  };
  aggregates: {
    totalProducts: number;
    totalCategories: number;
    totalCustomers: number;
    totalSuppliers: number;
    totalEmployees: number;
    totalActivePaid: number;
    totalSuspended: number;
    totalExpiredTrials: number;
  };
}

interface SalesOverview {
  today: { gross: string; count: number };
  thisMonth: { gross: string; count: number };
  thisYear: { gross: string; count: number };
  deltas: {
    todayWoW: number | null;
    thisMonthMoM: number | null;
    thisYearYoY: number | null;
  };
  series12mo: { month: string; gross: string; count: number }[];
  topStoresThisMonth: {
    tenantId: string;
    name: string;
    gross: string;
    count: number;
    plan: string | null;
  }[];
}

const fmtNum = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmtCurrency = (s: string) =>
  `₤${Number(s).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export function OverviewClient() {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.admin.overview;
  const tSales = dict.app.admin.sales.platform;
  const tList = dict.app.admin.tenants.list;
  const dateLocale = locale === "ar" ? "ar-EG" : "en-US";
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [sales, setSales] = useState<SalesOverview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/overview", { cache: "no-store" }).then((r) =>
        r.ok ? r.json() : null,
      ),
      fetch("/api/admin/sales/overview", { cache: "no-store" }).then((r) =>
        r.ok ? r.json() : null,
      ),
    ])
      .then(([o, s]) => {
        setData(o);
        setSales(s);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <p className="text-sm text-text-secondary text-center py-8">…</p>;
  }
  if (!data) {
    return (
      <p className="text-sm text-text-secondary text-center py-8">
        {t.lists.empty}
      </p>
    );
  }
  const k = data.kpis;
  const todayDelta =
    k.signupsLastWeekSameDay > 0
      ? Math.round(((k.todaySignups - k.signupsLastWeekSameDay) / k.signupsLastWeekSameDay) * 100)
      : null;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold">{t.title}</h1>
        <p className="text-sm text-text-secondary mt-1">{t.subtitle}</p>
      </header>

      {/* Requires Attention — Phase 1. Deliberately placed above the KPI
          row so the admin sees the actionable signals first. */}
      <AttentionPanel data={data.attention} dict={dict} />

      {/* Phase 2 — Real-time presence + active users. */}
      <PresencePanel data={data.presence} dict={dict} />

      {/* Phase 2 — Store activity rollup (active/sales-active/inactive). */}
      <StoreActivityPanel data={data.storeActivity} dict={dict} />

      {/* Phase 2 — Install + device analytics. */}
      <DeviceAnalyticsPanel data={data.devices} dict={dict} />

      {/* Phase 3 — Platform totals (products / categories / customers / etc). */}
      <PlatformTotalsPanel data={data.aggregates} dict={dict} />

      {/* KPI cards */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard
          label={t.kpis.totalTenants}
          value={fmtNum(k.totalTenants)}
          subline={
            k.totalTenantsDeltaThisWeek > 0
              ? t.kpis.thisWeekDelta.replace("{n}", String(k.totalTenantsDeltaThisWeek))
              : null
          }
        />
        <KpiCard
          label={t.kpis.trialing}
          value={fmtNum(k.trialing)}
          subline={
            k.trialingExpiringIn7d > 0
              ? t.kpis.expiringIn7d.replace("{n}", String(k.trialingExpiringIn7d))
              : null
          }
          sublineWarn={k.trialingExpiringIn7d > 0}
        />
        <KpiCard
          label={t.kpis.activePaid}
          value={fmtNum(k.activePaid)}
          subline={
            k.activePaidDeltaThisWeek > 0
              ? t.kpis.thisWeekDelta.replace("{n}", String(k.activePaidDeltaThisWeek))
              : null
          }
        />
        <KpiCard
          label={t.kpis.mrr}
          value={fmtCurrency(k.mrrEgp)}
          subline={
            Number(k.mrrDeltaThisWeekEgp) > 0
              ? t.kpis.thisWeekDelta.replace(
                  "{n}",
                  fmtCurrency(k.mrrDeltaThisWeekEgp),
                )
              : null
          }
        />
        <KpiCard
          label={t.kpis.todaySignups}
          value={fmtNum(k.todaySignups)}
          subline={
            todayDelta !== null
              ? t.kpis.wow.replace("{n}", String(todayDelta))
              : null
          }
        />
      </section>

      {/* Three lists row */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Trials expiring */}
        <ListCard title={t.lists.trialsExpiring}>
          {data.trialsExpiringSoon.length === 0 ? (
            <Empty t={t.lists.empty} />
          ) : (
            <ul className="divide-y divide-border">
              {data.trialsExpiringSoon.map((tr) => (
                <li key={tr.id} className="py-2.5 text-sm">
                  <Link
                    href={`/admin/tenants/${tr.id}`}
                    className="font-medium hover:text-accent"
                    dir="auto"
                  >
                    {tr.name}
                  </Link>
                  <p className="text-xs text-text-secondary truncate" dir="ltr">
                    {tr.ownerEmail ?? "—"} ·{" "}
                    {new Date(tr.trialEndsAt).toLocaleDateString(dateLocale)}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <Link
            href="/admin/tenants?status=trialing&trialExpiringInDays=7"
            className="block mt-2 text-xs text-accent"
          >
            {t.lists.viewAll}
          </Link>
        </ListCard>

        {/* Payment failures */}
        <ListCard title={t.lists.recentFailures}>
          {data.recentPaymentFailures.length === 0 ? (
            <Empty t={t.lists.empty} />
          ) : (
            <ul className="divide-y divide-border">
              {data.recentPaymentFailures.map((f) => (
                <li key={f.attemptedAt + f.tenantId} className="py-2.5 text-sm">
                  <Link
                    href={`/admin/tenants/${f.tenantId}`}
                    className="font-medium hover:text-accent"
                    dir="auto"
                  >
                    {f.tenantName}
                  </Link>
                  <p className="text-xs text-text-secondary">
                    {fmtCurrency(f.amountEgp)} ·{" "}
                    {new Date(f.attemptedAt).toLocaleDateString(dateLocale)}
                  </p>
                  {f.failureReason && (
                    <p className="text-[11px] text-danger mt-0.5 truncate">
                      {f.failureReason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </ListCard>

        {/* Admin activity */}
        <ListCard title={t.lists.recentAdminActivity}>
          {data.recentAdminActivity.length === 0 ? (
            <Empty t={t.lists.empty} />
          ) : (
            <ul className="divide-y divide-border">
              {data.recentAdminActivity.map((a) => (
                <li key={a.id} className="py-2.5 text-xs">
                  <span className="font-mono text-[11px] bg-bg-main rounded px-1 py-0.5">
                    {a.action}
                  </span>
                  <p className="text-text-secondary mt-1 truncate" dir="ltr">
                    {a.adminEmail ?? "—"} ·{" "}
                    {new Date(a.occurredAt).toLocaleString(dateLocale)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </ListCard>
      </section>

      {/* Two charts row */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ListCard title={t.charts.planDistribution}>
          <PlanDonut rows={data.planDistribution} labels={tList.filters} />
        </ListCard>
        <ListCard title={t.charts.signups30d}>
          <Sparkline rows={data.signupsLast30Days} />
        </ListCard>
      </section>

      {/* ── Platform sales (Spec 09) ─────────────────────────────────── */}
      {sales && (
        <>
          <header className="pt-2">
            <h2 className="text-xl font-bold">{tSales.title}</h2>
            <p className="text-sm text-text-secondary mt-0.5">{tSales.subtitle}</p>
          </header>

          <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <KpiCard
              label={tSales.kpis.todayGmv}
              value={fmtCurrency(sales.today.gross)}
              subline={
                sales.deltas.todayWoW != null
                  ? `${sales.deltas.todayWoW > 0 ? "▲" : sales.deltas.todayWoW < 0 ? "▼" : "·"} ${Math.abs(sales.deltas.todayWoW)}% ${tSales.kpis.wow}`
                  : tSales.kpis.saleCount.replace("{n}", String(sales.today.count))
              }
            />
            <KpiCard
              label={tSales.kpis.thisMonthGmv}
              value={fmtCurrency(sales.thisMonth.gross)}
              subline={
                sales.deltas.thisMonthMoM != null
                  ? `${sales.deltas.thisMonthMoM > 0 ? "▲" : sales.deltas.thisMonthMoM < 0 ? "▼" : "·"} ${Math.abs(sales.deltas.thisMonthMoM)}% ${tSales.kpis.mom}`
                  : tSales.kpis.saleCount.replace("{n}", String(sales.thisMonth.count))
              }
            />
            <KpiCard
              label={tSales.kpis.thisYearGmv}
              value={fmtCurrency(sales.thisYear.gross)}
              subline={
                sales.deltas.thisYearYoY != null
                  ? `${sales.deltas.thisYearYoY > 0 ? "▲" : sales.deltas.thisYearYoY < 0 ? "▼" : "·"} ${Math.abs(sales.deltas.thisYearYoY)}% ${tSales.kpis.yoy}`
                  : tSales.kpis.saleCount.replace("{n}", String(sales.thisYear.count))
              }
            />
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <ListCard title={tSales.chart.title}>
              <MonthlyBarChart rows={sales.series12mo} />
            </ListCard>
            <ListCard title={tSales.topStores.title}>
              {sales.topStoresThisMonth.length === 0 ? (
                <p className="text-xs text-text-secondary text-center py-4">
                  {tSales.topStores.empty}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {sales.topStoresThisMonth.map((s, i) => (
                    <li key={s.tenantId} className="py-2 text-sm">
                      <Link
                        href={`/admin/tenants/${s.tenantId}`}
                        className="flex items-center justify-between hover:text-accent"
                      >
                        <span className="font-medium truncate" dir="auto">
                          {i + 1}. {s.name}
                        </span>
                        <span className="text-text-secondary" dir="ltr">
                          {fmtCurrency(s.gross)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </ListCard>
            <ListCard title={dict.app.admin.sales.list.title}>
              <Link
                href="/admin/sales"
                className="block text-xs text-accent text-center py-6"
              >
                {dict.app.admin.sales.list.subtitle}
              </Link>
            </ListCard>
          </section>
        </>
      )}

      {/* Unused void to keep dateLocale honest */}
      <span className="hidden" aria-hidden>
        {dateLocale}
      </span>
    </div>
  );
}

/** Live presence — "who is using Storo right now".
 *  All counts are exact across the platform (SQL aggregates, no sampling).
 *  Reads one payload; splits into KPI tiles + platform mini-cards. */
function PresencePanel({
  data,
  dict,
}: {
  data: OverviewPayload["presence"];
  dict: ReturnType<typeof useDictionary>;
}) {
  const t = (dict.app.admin.overview as unknown as {
    presence: {
      title: string;
      onlineNow: string;
      active5m: string;
      active15m: string;
      activeToday: string;
      dau: string;
      wau: string;
      mau: string;
      platformSplit: string;
      platform: {
        ios: string;
        android: string;
        web: string;
        other: string;
      };
      liveDot: string;
    };
  }).presence;
  return (
    <section className="bg-white rounded-2xl border border-border overflow-hidden">
      <header className="px-5 py-3 border-b border-border flex items-center gap-2">
        <span className="relative inline-flex w-2 h-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
        </span>
        <h2 className="text-sm font-semibold">{t.title}</h2>
      </header>
      <div className="grid grid-cols-2 md:grid-cols-7 gap-0">
        <PresenceTile label={t.onlineNow} value={data.onlineNow} highlight />
        <PresenceTile label={t.active5m} value={data.active5m} />
        <PresenceTile label={t.active15m} value={data.active15m} />
        <PresenceTile label={t.activeToday} value={data.activeToday} />
        <PresenceTile label={t.dau} value={data.dau} />
        <PresenceTile label={t.wau} value={data.wau} />
        <PresenceTile label={t.mau} value={data.mau} />
      </div>
      <div className="px-5 py-3 border-t border-border">
        <p className="text-[11px] text-text-secondary uppercase tracking-wider mb-2">
          {t.platformSplit}
        </p>
        <div className="grid grid-cols-4 gap-3">
          <PlatformCell label={t.platform.ios} value={data.byPlatform.ios} />
          <PlatformCell
            label={t.platform.android}
            value={data.byPlatform.android}
          />
          <PlatformCell label={t.platform.web} value={data.byPlatform.web} />
          <PlatformCell
            label={t.platform.other}
            value={data.byPlatform.other}
          />
        </div>
      </div>
    </section>
  );
}

function PresenceTile({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div className="p-4 border-e border-b md:border-b-0 border-border last:border-e-0">
      <p className="text-[11px] text-text-secondary uppercase tracking-wider">
        {label}
      </p>
      <p
        className={`text-2xl font-bold mt-1 tabular-nums ${highlight ? "text-success" : ""}`}
        dir="ltr"
      >
        {value.toLocaleString("en-US")}
      </p>
    </div>
  );
}

function PlatformCell({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className="text-lg font-semibold tabular-nums" dir="ltr">
        {value.toLocaleString("en-US")}
      </p>
    </div>
  );
}

/** Store activity rollup — active/sales-active/inactive buckets at a
 *  glance, plus a 30-day distinct-active-store sparkline. */
function StoreActivityPanel({
  data,
  dict,
}: {
  data: OverviewPayload["storeActivity"];
  dict: ReturnType<typeof useDictionary>;
}) {
  const t = (dict.app.admin.overview as unknown as {
    storeActivity: {
      title: string;
      activeToday: string;
      active7d: string;
      active30d: string;
      salesActiveToday: string;
      salesActive7d: string;
      salesActive30d: string;
      inactive7d: string;
      inactive14d: string;
      inactive30d: string;
      trend: string;
    };
  }).storeActivity;
  return (
    <section className="bg-white rounded-2xl border border-border p-5">
      <h2 className="text-sm font-semibold mb-3">{t.title}</h2>
      <div className="grid grid-cols-3 gap-3">
        <StoreActivityColumn
          title={t.activeToday.split(" ")[0] ?? ""}
          items={[
            { label: t.activeToday, value: data.activeToday },
            { label: t.active7d, value: data.active7d },
            { label: t.active30d, value: data.active30d },
          ]}
          tone="success"
        />
        <StoreActivityColumn
          title=""
          items={[
            { label: t.salesActiveToday, value: data.salesActiveToday },
            { label: t.salesActive7d, value: data.salesActive7d },
            { label: t.salesActive30d, value: data.salesActive30d },
          ]}
          tone="accent"
        />
        <StoreActivityColumn
          title=""
          items={[
            { label: t.inactive7d, value: data.inactive7d, warn: true },
            { label: t.inactive14d, value: data.inactive14d, warn: true },
            { label: t.inactive30d, value: data.inactive30d, warn: true },
          ]}
          tone="warn"
        />
      </div>
      <div className="mt-4">
        <p className="text-[11px] text-text-secondary uppercase tracking-wider mb-1.5">
          {t.trend}
        </p>
        <Sparkline
          rows={data.activityTrend30d.map((r) => ({ day: r.day, count: r.stores }))}
        />
      </div>
    </section>
  );
}

function StoreActivityColumn({
  title,
  items,
  tone,
}: {
  title: string;
  items: { label: string; value: number; warn?: boolean }[];
  tone: "success" | "accent" | "warn";
}) {
  const DOT = {
    success: "bg-success",
    accent: "bg-accent",
    warn: "bg-orange-500",
  } as const;
  return (
    <div className="bg-bg-main/30 rounded-xl p-3">
      {title && (
        <div className="flex items-center gap-1.5 mb-2">
          <span className={`w-1.5 h-1.5 rounded-full ${DOT[tone]}`} />
          <span className="text-[11px] uppercase tracking-wider text-text-secondary">
            {title}
          </span>
        </div>
      )}
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li
            key={it.label}
            className="flex items-baseline justify-between text-sm"
          >
            <span className="text-text-secondary text-xs">{it.label}</span>
            <span
              className={`font-bold tabular-nums ${it.warn ? "text-orange-700" : ""}`}
              dir="ltr"
            >
              {it.value.toLocaleString("en-US")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Install + device analytics — install counts, per-platform active
 *  devices, 90-day install trend, and app-version distribution. */
function DeviceAnalyticsPanel({
  data,
  dict,
}: {
  data: OverviewPayload["devices"];
  dict: ReturnType<typeof useDictionary>;
}) {
  const t = (dict.app.admin.overview as unknown as {
    devices: {
      title: string;
      activeDevicesNow: string;
      activeDevicesToday: string;
      installsToday: string;
      installsThisWeek: string;
      installsThisMonth: string;
      byPlatform: string;
      platform: {
        ios: string;
        android: string;
        web: string;
        other: string;
      };
      trend: string;
      versions: string;
      versionLabel: string;
      versionsEmpty: string;
    };
  }).devices;
  return (
    <section className="bg-white rounded-2xl border border-border overflow-hidden">
      <header className="px-5 py-3 border-b border-border">
        <h2 className="text-sm font-semibold">{t.title}</h2>
      </header>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-0">
        <PresenceTile label={t.activeDevicesNow} value={data.activeDevicesNow} />
        <PresenceTile label={t.activeDevicesToday} value={data.activeDevicesToday} />
        <PresenceTile label={t.installsToday} value={data.installsToday} />
        <PresenceTile label={t.installsThisWeek} value={data.installsThisWeek} />
        <PresenceTile label={t.installsThisMonth} value={data.installsThisMonth} />
      </div>
      <div className="px-5 py-3 border-t border-border grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <p className="text-[11px] text-text-secondary uppercase tracking-wider mb-2">
            {t.byPlatform}
          </p>
          <div className="grid grid-cols-4 gap-3">
            <PlatformCell label={t.platform.ios} value={data.byPlatform.ios} />
            <PlatformCell label={t.platform.android} value={data.byPlatform.android} />
            <PlatformCell label={t.platform.web} value={data.byPlatform.web} />
            <PlatformCell label={t.platform.other} value={data.byPlatform.other} />
          </div>
        </div>
        <div>
          <p className="text-[11px] text-text-secondary uppercase tracking-wider mb-2">
            {t.trend}
          </p>
          <Sparkline
            rows={data.installsLast90d.map((r) => ({ day: r.day, count: r.count }))}
          />
        </div>
      </div>
      <div className="px-5 py-3 border-t border-border">
        <p className="text-[11px] text-text-secondary uppercase tracking-wider mb-2">
          {t.versions}
        </p>
        {data.appVersionDistribution.length === 0 ? (
          <p className="text-xs text-text-secondary">{t.versionsEmpty}</p>
        ) : (
          <ul className="space-y-1.5">
            {data.appVersionDistribution.slice(0, 8).map((v) => (
              <li
                key={`${v.platform}-${v.appVersion}`}
                className="flex items-baseline justify-between text-sm"
              >
                <span className="text-xs">
                  <span className="text-text-secondary">{v.platform}</span>{" "}
                  <span dir="ltr">{v.appVersion}</span>
                </span>
                <span className="font-semibold tabular-nums" dir="ltr">
                  {v.count.toLocaleString("en-US")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Phase 3 — platform-wide totals. Compact responsive grid; collapses to
 *  2 columns on mobile, 4 on tablet, 8 on desktop. */
function PlatformTotalsPanel({
  data,
  dict,
}: {
  data: OverviewPayload["aggregates"];
  dict: ReturnType<typeof useDictionary>;
}) {
  const t = (dict.app.admin.overview as unknown as {
    totals: {
      title: string;
      products: string;
      categories: string;
      customers: string;
      suppliers: string;
      employees: string;
      activePaid: string;
      suspended: string;
      expiredTrials: string;
    };
  }).totals;
  const items = [
    { label: t.products, value: data.totalProducts },
    { label: t.categories, value: data.totalCategories },
    { label: t.customers, value: data.totalCustomers },
    { label: t.suppliers, value: data.totalSuppliers },
    { label: t.employees, value: data.totalEmployees },
    { label: t.activePaid, value: data.totalActivePaid },
    { label: t.suspended, value: data.totalSuspended },
    { label: t.expiredTrials, value: data.totalExpiredTrials },
  ];
  return (
    <section className="bg-white rounded-2xl border border-border overflow-hidden">
      <header className="px-5 py-3 border-b border-border">
        <h2 className="text-sm font-semibold">{t.title}</h2>
      </header>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8">
        {items.map((it) => (
          <div
            key={it.label}
            className="p-4 border-e border-b sm:border-b-0 border-border last:border-e-0"
          >
            <p className="text-[11px] text-text-secondary uppercase tracking-wider">
              {it.label}
            </p>
            <p className="text-2xl font-bold mt-1 tabular-nums" dir="ltr">
              {it.value.toLocaleString("en-US")}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Requires-Attention panel. Hides itself when every count is zero so a
 *  quiet day doesn't waste screen space. Items deep-link to a filtered
 *  tenant list — the same filters the admin would set by hand. */
function AttentionPanel({
  data,
  dict,
}: {
  data: OverviewPayload["attention"];
  dict: ReturnType<typeof useDictionary>;
}) {
  const t = (dict.app.admin.overview as unknown as {
    attention: {
      title: string;
      allClear: string;
      critical: string;
      atRisk: string;
      attention: string;
      items: Record<string, string>;
    };
  }).attention;
  const critical = [
    {
      key: "suspended",
      count: data.critical.suspended,
      href: "/admin/tenants?status=suspended",
    },
    {
      key: "paymentFailures",
      count: data.critical.paymentFailures30d,
      href: "/admin/tenants?status=past_due",
    },
  ].filter((x) => x.count > 0);
  const atRisk = [
    {
      key: "highRisk",
      count: data.atRisk.highRiskStores,
      href: "/admin/tenants?risk=high",
    },
  ].filter((x) => x.count > 0);
  const attention = [
    {
      key: "trialsExpiring",
      count: data.attention.trialsExpiring7d,
      href: "/admin/tenants?status=trialing&trialExpiringInDays=7",
    },
    {
      key: "mediumRisk",
      count: data.attention.mediumRiskStores,
      href: "/admin/tenants?risk=medium",
    },
  ].filter((x) => x.count > 0);

  const total = critical.length + atRisk.length + attention.length;
  if (total === 0) {
    return (
      <section className="bg-success-light/50 border border-success-light rounded-2xl p-4 flex items-center gap-2">
        <span>✓</span>
        <p className="text-sm text-success">{t.allClear}</p>
      </section>
    );
  }
  return (
    <section className="bg-white rounded-2xl border border-border overflow-hidden">
      <header className="px-5 py-3 border-b border-border">
        <h2 className="text-sm font-semibold">{t.title}</h2>
      </header>
      <div className="grid grid-cols-1 md:grid-cols-3">
        <AttentionGroup
          tone="danger"
          title={t.critical}
          items={critical}
          itemsI18n={t.items}
        />
        <AttentionGroup
          tone="orange"
          title={t.atRisk}
          items={atRisk}
          itemsI18n={t.items}
        />
        <AttentionGroup
          tone="yellow"
          title={t.attention}
          items={attention}
          itemsI18n={t.items}
        />
      </div>
    </section>
  );
}

function AttentionGroup({
  tone,
  title,
  items,
  itemsI18n,
}: {
  tone: "danger" | "orange" | "yellow";
  title: string;
  items: { key: string; count: number; href: string }[];
  itemsI18n: Record<string, string>;
}) {
  const DOT = {
    danger: "bg-danger",
    orange: "bg-orange-500",
    yellow: "bg-yellow-400",
  } as const;
  return (
    <div className="p-5 border-b md:border-b-0 md:border-e border-border last:border-e-0 last:border-b-0">
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-2 h-2 rounded-full ${DOT[tone]}`} />
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
          {title}
        </h3>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-text-secondary">—</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((it) => (
            <li key={it.key}>
              <Link
                href={it.href}
                className="flex items-baseline gap-2 text-sm hover:text-accent"
              >
                <span className="font-bold tabular-nums" dir="ltr">
                  {it.count}
                </span>
                <span className="text-xs">
                  {(itemsI18n[it.key] ?? it.key).replace("{n}", String(it.count))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MonthlyBarChart({
  rows,
}: {
  rows: { month: string; gross: string; count: number }[];
}) {
  if (rows.length === 0) {
    return <p className="text-xs text-text-secondary text-center py-6">—</p>;
  }
  const values = rows.map((r) => Number(r.gross));
  const max = Math.max(1, ...values);
  return (
    <div>
      <div className="flex items-end gap-[3px] h-28">
        {rows.map((r, i) => {
          const v = Number(r.gross);
          const h = Math.max(2, (v / max) * 100);
          return (
            <div
              key={r.month}
              title={`${r.month}: ₤${Number(r.gross).toLocaleString("en-US", { maximumFractionDigits: 0 })} (${r.count})`}
              style={{ height: `${h}%` }}
              className={`flex-1 rounded-sm ${
                i === rows.length - 1 ? "bg-accent" : "bg-accent/40"
              }`}
            />
          );
        })}
      </div>
      <div className="flex items-center justify-between text-[10px] text-text-secondary mt-1.5" dir="ltr">
        <span>{rows[0]?.month}</span>
        <span>{rows[rows.length - 1]?.month}</span>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  subline,
  sublineWarn,
}: {
  label: string;
  value: string;
  subline: string | null;
  sublineWarn?: boolean;
}) {
  return (
    <div className="bg-white rounded-2xl border border-border p-4">
      <p className="text-[11px] text-text-secondary uppercase tracking-wider">
        {label}
      </p>
      <p className="text-2xl font-bold mt-1" dir="ltr">
        {value}
      </p>
      {subline && (
        <p
          className={`text-[11px] mt-1 ${
            sublineWarn ? "text-orange-700" : "text-text-secondary"
          }`}
          dir="ltr"
        >
          {subline}
        </p>
      )}
    </div>
  );
}

function ListCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border border-border p-4">
      <h2 className="text-sm font-semibold mb-2">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ t }: { t: string }) {
  return (
    <p className="text-xs text-text-secondary text-center py-6">{t}</p>
  );
}

function PlanDonut({
  rows,
  labels,
}: {
  rows: { plan: string; count: number }[];
  labels: Record<string, string>;
}) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  if (total === 0)
    return <p className="text-xs text-text-secondary text-center py-6">—</p>;
  const PALETTE: Record<string, string> = {
    trial: "bg-orange-300",
    professional: "bg-accent",
    multi_branch: "bg-success",
  };
  return (
    <div className="space-y-2">
      <div className="flex h-3 rounded-full overflow-hidden border border-border">
        {rows.map((r) => (
          <div
            key={r.plan}
            className={PALETTE[r.plan] ?? "bg-text-secondary"}
            style={{ width: `${(r.count / total) * 100}%` }}
            title={`${r.plan}: ${r.count}`}
          />
        ))}
      </div>
      <ul className="text-xs space-y-1">
        {rows.map((r) => (
          <li key={r.plan} className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5">
              <span
                className={`w-2.5 h-2.5 rounded-sm ${PALETTE[r.plan] ?? "bg-text-secondary"}`}
              />
              {labels[r.plan] ?? r.plan}
            </span>
            <span className="text-text-secondary">
              {r.count} ({Math.round((r.count / total) * 100)}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Sparkline({ rows }: { rows: { day: string; count: number }[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-text-secondary text-center py-6">—</p>;
  }
  const max = Math.max(1, ...rows.map((r) => r.count));
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <div>
      <p className="text-xs text-text-secondary mb-1.5" dir="ltr">
        Total: {total}
      </p>
      <div className="flex items-end gap-[2px] h-16">
        {rows.map((r) => {
          const h = Math.max(2, (r.count / max) * 100);
          return (
            <div
              key={r.day}
              title={`${r.day}: ${r.count}`}
              style={{ height: `${h}%` }}
              className="flex-1 bg-accent rounded-sm"
            />
          );
        })}
      </div>
      <div className="flex items-center justify-between text-[10px] text-text-secondary mt-1" dir="ltr">
        <span>{rows[0]?.day.slice(5)}</span>
        <span>{rows[rows.length - 1]?.day.slice(5)}</span>
      </div>
    </div>
  );
}
