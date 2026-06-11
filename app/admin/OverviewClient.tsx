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
