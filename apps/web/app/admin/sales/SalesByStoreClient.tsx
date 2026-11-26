"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface Row {
  tenantId: string;
  name: string;
  slug: string;
  plan: string | null;
  subscriptionStatus: string | null;
  suspended: boolean;
  gross: string;
  count: number;
  avgTicket: string;
  momPct: number | null;
  ownerEmail: string | null;
}

type Range =
  | "this_month"
  | "last_month"
  | "this_year"
  | "last_30d"
  | "last_90d";

const RANGES: Range[] = [
  "this_month",
  "last_month",
  "this_year",
  "last_30d",
  "last_90d",
];

const PLANS = ["", "trial", "professional", "multi_branch"] as const;
const STATUSES = ["", "active", "trialing", "suspended"] as const;

const fmtCurrency = (s: string) =>
  `₤${Number(s).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const fmtCurrencyFull = (s: string) =>
  `₤${Number(s).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function SalesByStoreClient() {
  const dict = useDictionary();
  const t = dict.app.admin.sales.list;
  const ranges = t.ranges as Record<Range, string>;

  const [range, setRange] = useState<Range>("this_month");
  const [plan, setPlan] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set("range", range);
    if (plan) p.set("plan", plan);
    if (status) p.set("status", status);
    return p;
  }, [range, plan, status]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/sales/tenants?${params.toString()}`,
        { cache: "no-store" },
      );
      if (res.ok) {
        const json = (await res.json()) as { data: Row[] };
        setRows(json.data);
      }
    } finally {
      setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    load();
  }, [load]);

  const totalGmv = rows.reduce((s, r) => s + Number(r.gross), 0);
  const totalCount = rows.reduce((s, r) => s + r.count, 0);
  const visibleRows = rows.filter((r) => Number(r.gross) > 0 || r.count > 0);

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t.title}</h1>
          <p className="text-sm text-text-secondary mt-1">{t.subtitle}</p>
        </div>
        <div className="text-end">
          <p className="text-xs text-text-secondary">
            {fmtCurrencyFull(String(totalGmv))} · {totalCount}{" "}
            {dict.app.admin.sales.platform.kpis.saleCount
              .replace("{n}", "")
              .trim()}
          </p>
        </div>
      </header>

      {/* Range chips */}
      <div className="flex flex-wrap gap-2">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              range === r
                ? "bg-accent text-white"
                : "bg-white border border-border text-text-secondary hover:border-accent"
            }`}
          >
            {ranges[r]}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 text-xs">
        <label className="inline-flex items-center gap-1.5">
          <span className="text-text-secondary">{t.planLabel}</span>
          <select
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
            className="rounded-md border border-border bg-white px-2 py-1"
          >
            {PLANS.map((p) => (
              <option key={p || "any"} value={p}>
                {p === "" ? t.planAny : p}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5">
          <span className="text-text-secondary">{t.statusLabel}</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded-md border border-border bg-white px-2 py-1"
          >
            {STATUSES.map((s) => (
              <option key={s || "any"} value={s}>
                {s === ""
                  ? t.statusAny
                  : s === "active"
                    ? t.statusActive
                    : s === "trialing"
                      ? t.statusTrialing
                      : t.statusSuspended}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary text-center py-8">…</p>
      ) : visibleRows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-border py-12 text-center">
          <p className="text-sm font-medium mb-1">{t.empty}</p>
          <p className="text-xs text-text-secondary">{t.emptyHint}</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-main/40 text-xs text-text-secondary">
                <tr>
                  <th className="text-start font-medium px-3 py-2">{t.columns.store}</th>
                  <th className="text-start font-medium px-3 py-2">{t.columns.owner}</th>
                  <th className="text-start font-medium px-3 py-2">{t.columns.plan}</th>
                  <th className="text-end font-medium px-3 py-2">{t.columns.gmv}</th>
                  <th className="text-end font-medium px-3 py-2">{t.columns.count}</th>
                  <th className="text-end font-medium px-3 py-2">{t.columns.avg}</th>
                  <th className="text-end font-medium px-3 py-2">{t.columns.mom}</th>
                  <th className="text-start font-medium px-3 py-2">{t.columns.status}</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => (
                  <tr key={r.tenantId} className="border-t border-border hover:bg-bg-main/30">
                    <td className="px-3 py-2">
                      <Link
                        href={`/admin/tenants/${r.tenantId}`}
                        className="font-medium hover:text-accent"
                        dir="auto"
                      >
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs text-text-secondary" dir="ltr">
                      {r.ownerEmail ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-xs">{r.plan ?? "—"}</td>
                    <td className="px-3 py-2 text-end tabular-nums" dir="ltr">
                      {fmtCurrency(r.gross)}
                    </td>
                    <td className="px-3 py-2 text-end tabular-nums">{r.count}</td>
                    <td className="px-3 py-2 text-end tabular-nums" dir="ltr">
                      {fmtCurrencyFull(r.avgTicket)}
                    </td>
                    <td className="px-3 py-2 text-end" dir="ltr">
                      {r.momPct == null ? (
                        "—"
                      ) : (
                        <span
                          className={
                            r.momPct > 0
                              ? "text-success font-semibold"
                              : r.momPct < 0
                                ? "text-danger font-semibold"
                                : "text-text-secondary"
                          }
                        >
                          {r.momPct > 0 ? "+" : ""}
                          {r.momPct}%
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {r.suspended ? (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-danger-light text-danger">
                          {t.suspendedBadge}
                        </span>
                      ) : r.subscriptionStatus === "active" ? (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-success-light text-success">
                          {t.statusActive}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-bg-main text-text-secondary">
                          {r.subscriptionStatus ?? "—"}
                        </span>
                      )}
                    </td>
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
