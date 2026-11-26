"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

// The admin backend still returns `branchCount` for backward compat with
// internal APIs; it is deliberately absent from this interface so no UI
// renders it. Storo has no branches.
interface Row {
  id: string;
  name: string;
  slug: string;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerPhone: string | null;
  plan: string | null;
  status: string;
  trialEndsAt: string | null;
  employeeCount: number;
  lastSaleAt: string | null;
  mrr: string;
  createdAt: string;
  suspendedAt: string | null;
  health: { score: number; status: "healthy" | "attention" | "at_risk" } | null;
  risk: { level: "healthy" | "low" | "medium" | "high"; score: number } | null;
  lastActivityAt: string | null;
  productCount: number;
  categoryCount: number;
  customerCount: number;
  supplierCount: number;
}

const STATUS_VALUES = [
  "",
  "trialing",
  "active",
  "past_due",
  "cancelled",
  "expired",
  "suspended",
] as const;

const PLANS = ["", "trial", "professional"] as const;
const TRIAL_DAYS = ["", "3", "7", "14"] as const;
const HEALTH_VALUES = ["", "healthy", "attention", "at_risk"] as const;
const RISK_VALUES = ["", "healthy", "low", "medium", "high"] as const;

const fmtNum = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 0 });

function ago(iso: string | null, locale: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(locale === "ar" ? "ar-EG" : "en-US");
}

export function TenantsListClient() {
  const router = useRouter();
  const sp = useSearchParams();
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.admin.tenants.list;
  const fl = t.filters;

  const [q, setQ] = useState(sp.get("q") ?? "");
  const [status, setStatus] = useState(sp.get("status") ?? "");
  const [plan, setPlan] = useState(sp.get("plan") ?? "");
  const [trialDays, setTrialDays] = useState(sp.get("trialExpiringInDays") ?? "");
  const [health, setHealth] = useState(sp.get("health") ?? "");
  const [risk, setRisk] = useState(sp.get("risk") ?? "");
  const [rows, setRows] = useState<Row[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (status) params.set("status", status);
    if (plan) params.set("plan", plan);
    if (trialDays) params.set("trialExpiringInDays", trialDays);
    if (health) params.set("health", health);
    if (risk) params.set("risk", risk);
    return params.toString();
  }, [q, status, plan, trialDays, health, risk]);

  // Sync URL state so links / bookmarks survive a refresh.
  useEffect(() => {
    router.replace(`/admin/tenants${url ? "?" + url : ""}`, { scroll: false });
  }, [url, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/tenants?${url}`, { cache: "no-store" });
      if (res.ok) {
        const json = (await res.json()) as { data: Row[]; truncated?: boolean };
        setRows(json.data);
        setTruncated(!!json.truncated);
      }
    } finally {
      setLoading(false);
    }
  }, [url]);

  // Debounce search input — 250 ms.
  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  void debouncedQ;

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <header>
        <h1 className="text-2xl font-bold">{t.title}</h1>
        <p className="text-sm text-text-secondary mt-1">{t.subtitle}</p>
      </header>

      {/* Search + filter row */}
      <section className="space-y-3">
        <input
          type="search"
          dir="auto"
          placeholder={t.searchPlaceholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full px-4 py-2.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />

        {/* Status chips — same shape as /inventory + /cash-shifts. */}
        <div className="flex flex-wrap gap-2">
          {STATUS_VALUES.map((s) => (
            <button
              key={s || "all"}
              onClick={() => setStatus(s)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                status === s
                  ? "bg-accent text-white"
                  : "bg-white border border-border text-text-secondary hover:border-accent"
              }`}
            >
              {(fl as Record<string, string>)[s || "all"] ?? s}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-3 text-xs">
          <Select
            label={fl.plan}
            value={plan}
            onChange={setPlan}
            options={PLANS.map((p) => ({
              value: p,
              label:
                p === ""
                  ? fl.all
                  : (fl as Record<string, string>)[p] ?? p,
            }))}
          />
          <Select
            label={fl.trialExpiring}
            value={trialDays}
            onChange={setTrialDays}
            options={TRIAL_DAYS.map((d) => ({
              value: d,
              label: d === "" ? fl.all : `${d}d`,
            }))}
          />
          <Select
            label={fl.health}
            value={health}
            onChange={setHealth}
            options={HEALTH_VALUES.map((h) => ({
              value: h,
              label: h === "" ? fl.all : fl[`health_${h}` as keyof typeof fl] ?? h,
            }))}
          />
          <Select
            label={fl.risk}
            value={risk}
            onChange={setRisk}
            options={RISK_VALUES.map((v) => ({
              value: v,
              label: v === "" ? fl.all : fl[`risk_${v}` as keyof typeof fl] ?? v,
            }))}
          />
        </div>
      </section>

      {/* Truncation warning — health/risk filters widen the fetch but don't
          scan the whole platform. Surface honestly so admins never read this
          list as exhaustive. Platform-wide KPIs on the Overview use the exact
          SQL aggregator and are unaffected. */}
      {truncated && (
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 text-xs text-orange-800">
          {t.truncatedWarning}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <p className="text-sm text-text-secondary text-center py-8">…</p>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-border py-12 text-center">
          <p className="text-sm font-medium mb-1">{t.empty}</p>
          <p className="text-xs text-text-secondary">{t.emptyHint}</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-main/40">
                <tr className="text-xs text-text-secondary">
                  <Th>{t.columns.name}</Th>
                  <Th>{t.columns.owner}</Th>
                  <Th>{t.columns.plan}</Th>
                  <Th className="text-end">{t.columns.employees}</Th>
                  <Th className="text-end">{t.columns.products}</Th>
                  <Th className="text-end">{t.columns.categories}</Th>
                  <Th>{t.columns.lastLogin}</Th>
                  <Th>{t.columns.lastActivity}</Th>
                  <Th className="text-end">{t.columns.mrr}</Th>
                  <Th>{t.columns.health}</Th>
                  <Th>{t.columns.risk}</Th>
                  <Th>{t.columns.status}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border hover:bg-bg-main/30">
                    <Td>
                      <Link
                        href={`/admin/tenants/${r.id}`}
                        className="font-medium hover:text-accent"
                        dir="auto"
                      >
                        {r.name}
                      </Link>
                    </Td>
                    <Td>
                      <p className="text-xs" dir="ltr">
                        {r.ownerEmail ?? "—"}
                      </p>
                      <p className="text-[11px] text-text-secondary truncate" dir="ltr">
                        {r.ownerPhone ?? ""}
                      </p>
                    </Td>
                    <Td>
                      <span className="text-xs">{r.plan ?? "—"}</span>
                    </Td>
                    <Td className="text-end tabular-nums">
                      {fmtNum(r.employeeCount)}
                    </Td>
                    <Td className="text-end tabular-nums">
                      {fmtNum(r.productCount)}
                    </Td>
                    <Td className="text-end tabular-nums">
                      {fmtNum(r.categoryCount)}
                    </Td>
                    <Td>
                      <span className="text-xs text-text-secondary">
                        {ago(r.lastSaleAt, locale)}
                      </span>
                    </Td>
                    <Td>
                      <LastActivityCell iso={r.lastActivityAt} locale={locale} />
                    </Td>
                    <Td className="text-end tabular-nums">
                      <span dir="ltr">₤{fmtNum(Number(r.mrr))}</span>
                    </Td>
                    <Td>
                      <HealthCell health={r.health} t={fl} />
                    </Td>
                    <Td>
                      <RiskCell risk={r.risk} t={fl} />
                    </Td>
                    <Td>
                      <StatusBadge status={r.status} t={fl} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="inline-flex items-center gap-1.5">
      <span className="text-text-secondary">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border bg-white px-2 py-1"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th className={`text-start font-medium px-3 py-2 whitespace-nowrap ${className ?? ""}`}>
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 align-top ${className ?? ""}`}>{children}</td>;
}

/** Relative "last activity" indicator with a live green dot when within
 *  the 5-minute online window. The absolute date is still shown as a title
 *  attr for admins who need the exact timestamp. */
function LastActivityCell({
  iso,
  locale,
}: {
  iso: string | null;
  locale: string;
}) {
  if (!iso) return <span className="text-text-secondary">—</span>;
  const d = new Date(iso);
  const ageMs = Date.now() - d.getTime();
  const isOnline = ageMs < 5 * 60 * 1000;
  const label = (() => {
    const min = Math.floor(ageMs / 60_000);
    if (min < 1) return "<1m";
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day}d`;
    return d.toLocaleDateString(locale === "ar" ? "ar-EG" : "en-US");
  })();
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs"
      dir="ltr"
      title={d.toLocaleString(locale === "ar" ? "ar-EG" : "en-US")}
    >
      {isOnline && (
        <span className="relative inline-flex w-1.5 h-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success" />
        </span>
      )}
      <span className={isOnline ? "text-success font-medium" : "text-text-secondary"}>
        {label}
      </span>
    </span>
  );
}

function HealthCell({
  health,
  t,
}: {
  health: { score: number; status: "healthy" | "attention" | "at_risk" } | null;
  t: Record<string, string>;
}) {
  if (!health) return <span className="text-text-secondary">—</span>;
  const TONE = {
    healthy: "bg-success-light text-success",
    attention: "bg-orange-100 text-orange-700",
    at_risk: "bg-danger-light text-danger",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${TONE[health.status]}`}
      dir="ltr"
    >
      <span className="tabular-nums">{health.score}</span>
      <span className="opacity-70">·</span>
      <span>{t[`health_${health.status}`] ?? health.status}</span>
    </span>
  );
}

function RiskCell({
  risk,
  t,
}: {
  risk: { level: "healthy" | "low" | "medium" | "high"; score: number } | null;
  t: Record<string, string>;
}) {
  if (!risk) return <span className="text-text-secondary">—</span>;
  const TONE = {
    healthy: "bg-success-light text-success",
    low: "bg-bg-main text-text-secondary",
    medium: "bg-orange-100 text-orange-700",
    high: "bg-danger-light text-danger",
  } as const;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${TONE[risk.level]}`}
    >
      {t[`risk_${risk.level}`] ?? risk.level}
    </span>
  );
}

function StatusBadge({
  status,
  t,
}: {
  status: string;
  t: Record<string, string>;
}) {
  const TONE: Record<string, string> = {
    trialing: "bg-orange-100 text-orange-700",
    active: "bg-success-light text-success",
    past_due: "bg-danger-light text-danger",
    cancelled: "bg-bg-main text-text-secondary",
    expired: "bg-bg-main text-text-secondary",
    suspended: "bg-danger-light text-danger",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${
        TONE[status] ?? "bg-bg-main text-text-secondary"
      }`}
    >
      {t[status] ?? status}
    </span>
  );
}
