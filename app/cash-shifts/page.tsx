"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

interface ShiftRow {
  id: string;
  branchName: string | null;
  cashierName: string | null;
  status: "open" | "closed" | "reviewed";
  openedAt: string;
  closedAt: string | null;
  expectedCash: string | null;
  countedCash: string | null;
  variance: string | null;
}

const fmt = (s: string | null | undefined) =>
  s == null
    ? "—"
    : Number(s).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

export default function CashShiftsListPage() {
  const params = useSearchParams();
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.cashShifts.list;
  const dateLocale = locale === "ar" ? "ar-EG" : "en-US";

  const initialStatus = params.get("status") ?? "";
  const [statusFilter, setStatusFilter] = useState<string>(initialStatus);
  const [rows, setRows] = useState<ShiftRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (statusFilter) qs.set("status", statusFilter);
      const res = await fetch(`/api/cash-shifts?${qs.toString()}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const json: { data: ShiftRow[] } = await res.json();
        setRows(json.data);
      }
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const grouped = useMemo(() => {
    const open: ShiftRow[] = [];
    const needsReview: ShiftRow[] = [];
    const other: ShiftRow[] = [];
    for (const r of rows) {
      if (r.status === "open") open.push(r);
      else if (
        r.status === "closed" &&
        r.variance != null &&
        Math.abs(Number(r.variance)) >= 1
      ) {
        needsReview.push(r);
      } else other.push(r);
    }
    return { open, needsReview, other };
  }, [rows]);

  return (
    <AppShell title={t.title}>
      <div className="max-w-5xl mx-auto space-y-4">
        <header>
          <h1 className="text-2xl font-bold">{t.title}</h1>
          <p className="text-sm text-text-secondary mt-0.5">{t.subtitle}</p>
        </header>

        {/* Filter chips — mirrors the inventory category-filter pattern in
            components/inventory/InventoryFilters.tsx so the shop has one
            consistent filter look across every list page. */}
        <div className="flex flex-wrap gap-2">
          {(
            [
              { value: "", label: t.filters.all },
              { value: "open", label: t.filters.open },
              { value: "needs_review", label: t.filters.needsReview },
              { value: "closed", label: t.filters.closed },
              { value: "reviewed", label: t.filters.reviewed },
            ] as const
          ).map((c) => (
            <button
              key={c.value}
              onClick={() => setStatusFilter(c.value)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                statusFilter === c.value
                  ? "bg-accent text-white"
                  : "bg-white border border-border text-text-secondary hover:border-accent"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="text-sm text-text-secondary text-center py-8">…</p>
        ) : rows.length === 0 ? (
          <div className="bg-white rounded-2xl border border-border py-12 text-center">
            <p className="text-sm font-medium text-text-primary mb-1">
              {t.emptyTitle}
            </p>
            <p className="text-xs text-text-secondary">{t.emptyHint}</p>
          </div>
        ) : (
          <div className="space-y-5">
            {grouped.open.length > 0 && (
              <Section
                title={t.sections.openNow}
                rows={grouped.open}
                t={t}
                dateLocale={dateLocale}
              />
            )}
            {grouped.needsReview.length > 0 && (
              <Section
                title={t.sections.needsReview}
                rows={grouped.needsReview}
                tone="warn"
                t={t}
                dateLocale={dateLocale}
              />
            )}
            {grouped.other.length > 0 && (
              <Section
                title={t.sections.other}
                rows={grouped.other}
                t={t}
                dateLocale={dateLocale}
              />
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}

interface SectionT {
  row: { openNow: string; countedShortLabel: string; expectedShortLabel: string };
}

function Section({
  title,
  rows,
  tone,
  t,
  dateLocale,
}: {
  title: string;
  rows: ShiftRow[];
  tone?: "warn";
  t: SectionT;
  dateLocale: string;
}) {
  return (
    <section
      className={`rounded-2xl border ${
        tone === "warn" ? "border-orange-200 bg-orange-50/30" : "border-border bg-white"
      }`}
    >
      <header className="px-5 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-text-secondary">{rows.length}</span>
      </header>
      <ul className="divide-y divide-border">
        {rows.map((r) => {
          const variance = r.variance != null ? Number(r.variance) : null;
          const varianceTone =
            variance == null
              ? "neutral"
              : Math.abs(variance) < 1
                ? "good"
                : variance < 0
                  ? "bad"
                  : "warn";
          return (
            <li key={r.id}>
              <Link
                href={`/cash-shifts/${r.id}`}
                className="flex items-center justify-between px-5 py-3 hover:bg-bg-main/30"
              >
                <div>
                  <p className="text-sm font-medium" dir="auto">
                    {r.cashierName ?? "—"}{" "}
                    <span className="text-xs text-text-secondary">
                      · {r.branchName ?? ""}
                    </span>
                  </p>
                  <p className="text-xs text-text-secondary mt-0.5">
                    {new Date(r.openedAt).toLocaleString(dateLocale)}
                    {r.closedAt
                      ? ` → ${new Date(r.closedAt).toLocaleTimeString(dateLocale, {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}`
                      : ` · ${t.row.openNow}`}
                  </p>
                </div>
                <div className="text-end">
                  {variance != null ? (
                    <p
                      dir="ltr"
                      className={`text-sm font-bold ${
                        varianceTone === "good"
                          ? "text-success"
                          : varianceTone === "bad"
                            ? "text-danger"
                            : "text-orange-700"
                      }`}
                    >
                      {variance > 0 ? "+" : ""}₤{fmt(r.variance)}
                    </p>
                  ) : (
                    <p className="text-xs text-text-secondary">—</p>
                  )}
                  <p className="text-[11px] text-text-secondary">
                    {t.row.countedShortLabel} ₤{fmt(r.countedCash)} ·{" "}
                    {t.row.expectedShortLabel} ₤{fmt(r.expectedCash)}
                  </p>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
