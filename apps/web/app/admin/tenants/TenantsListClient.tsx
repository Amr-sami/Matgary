"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

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
  branchCount: number;
  employeeCount: number;
  lastSaleAt: string | null;
  mrr: string;
  createdAt: string;
  suspendedAt: string | null;
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

const PLANS = ["", "trial", "professional", "multi_branch"] as const;
const BRANCH_BUCKETS = ["", "1", "2-3", "4+"] as const;
const TRIAL_DAYS = ["", "3", "7", "14"] as const;

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
  const [branchCount, setBranchCount] = useState(sp.get("branchCount") ?? "");
  const [trialDays, setTrialDays] = useState(sp.get("trialExpiringInDays") ?? "");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (status) params.set("status", status);
    if (plan) params.set("plan", plan);
    if (branchCount) params.set("branchCount", branchCount);
    if (trialDays) params.set("trialExpiringInDays", trialDays);
    return params.toString();
  }, [q, status, plan, branchCount, trialDays]);

  // Sync URL state so links / bookmarks survive a refresh.
  useEffect(() => {
    router.replace(`/admin/tenants${url ? "?" + url : ""}`, { scroll: false });
  }, [url, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/tenants?${url}`, { cache: "no-store" });
      if (res.ok) {
        const json = (await res.json()) as { data: Row[] };
        setRows(json.data);
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
            label={fl.branchCount}
            value={branchCount}
            onChange={setBranchCount}
            options={BRANCH_BUCKETS.map((b) => ({
              value: b,
              label:
                b === ""
                  ? fl.all
                  : b === "1"
                    ? fl.branchCount_1
                    : b === "2-3"
                      ? fl.branchCount_23
                      : fl.branchCount_4p,
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
        </div>
      </section>

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
                  <Th className="text-end">{t.columns.branches}</Th>
                  <Th className="text-end">{t.columns.employees}</Th>
                  <Th>{t.columns.lastLogin}</Th>
                  <Th className="text-end">{t.columns.mrr}</Th>
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
                    <Td className="text-end tabular-nums">{fmtNum(r.branchCount)}</Td>
                    <Td className="text-end tabular-nums">
                      {fmtNum(r.employeeCount)}
                    </Td>
                    <Td>
                      <span className="text-xs text-text-secondary">
                        {ago(r.lastSaleAt, locale)}
                      </span>
                    </Td>
                    <Td className="text-end tabular-nums">
                      <span dir="ltr">₤{fmtNum(Number(r.mrr))}</span>
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
