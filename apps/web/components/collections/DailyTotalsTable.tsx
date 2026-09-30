"use client";

import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";
import type { CollectionsSummary } from "@/lib/api/collections";

type Bucket = { count: number; amount: number };
const COLS = ["confirmed", "autoConfirmed", "pending", "rejectedDebt", "rejectedLoss", "unmatchedCredits"] as const;
type Col = (typeof COLS)[number];

/**
 * The digital "Z" per account for one day (doc 15 spec 12 §4.7, Q12): one
 * row per account (`collections-totals-account-<accountId>`, `none` for the
 * no-account row), each cell "count · amount", limit warnings as orange
 * chips, and a totals row with the cash taken on split invoices. The numbers
 * are the server's `GET /api/collections/summary`, never recomputed here.
 */
export function DailyTotalsTable({ summary, showCredits }: { summary: CollectionsSummary; showCredits: boolean }) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.collections.totals as Record<string, unknown> & typeof dict.app.collections.totals;
  const web = dict.app.collections.web.totals;
  const providers = dict.app.collections.vocab.providers as Record<string, string>;
  const limitLabels = t.limit as Record<string, string>;
  const cols: Col[] = COLS.filter((c) => c !== "unmatchedCredits" || showCredits);
  const label = (c: Col) => (t as unknown as Record<string, string>)[c] ?? c;

  const empty =
    summary.accounts.length === 0 ||
    summary.accounts.every((a) => cols.every((c) => (a[c] as Bucket).count === 0));
  if (empty) {
    return (
      <p data-testid="collections-totals-empty" className="px-4 py-8 text-center text-sm text-text-secondary">
        {t.empty}
      </p>
    );
  }

  const cell = (b: Bucket) =>
    b.count === 0 ? (
      <span className="text-text-secondary/60">—</span>
    ) : (
      <span className="tabular-nums whitespace-nowrap">
        {b.count} · {formatCurrency(b.amount, locale)}
      </span>
    );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-text-secondary">
            <th className="text-start font-medium px-3 py-2 whitespace-nowrap">{web.account}</th>
            {cols.map((c) => (
              <th key={c} className="text-start font-medium px-3 py-2 whitespace-nowrap">
                {label(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {summary.accounts.map((a) => (
            <tr
              key={a.accountId ?? "none"}
              data-testid={`collections-totals-account-${a.accountId ?? "none"}`}
              className="border-b border-border last:border-0 align-top"
            >
              <td className="px-3 py-2 min-w-[9rem]">
                <p className="font-semibold text-text-primary" dir="auto">
                  {a.accountId ? a.label : web.noAccount}
                </p>
                {a.provider && <p className="text-[10px] text-text-secondary">{providers[a.provider] ?? a.provider}</p>}
                {a.limitWarnings.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {a.limitWarnings.map((w) => (
                      <span key={w} className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">
                        {limitLabels[w] ?? w}
                      </span>
                    ))}
                  </div>
                )}
              </td>
              {cols.map((c) => (
                <td key={c} className="px-3 py-2">
                  {cell(a[c] as Bucket)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr data-testid="collections-totals-total" className="border-t-2 border-border font-semibold">
            <td className="px-3 py-2">{t.total}</td>
            {cols.map((c) => (
              <td key={c} className="px-3 py-2">
                {cell(summary.totals[c] as Bucket)}
              </td>
            ))}
          </tr>
          <tr>
            <td colSpan={cols.length + 1} className="px-3 py-2 text-text-secondary">
              {t.cashRemainder}:{" "}
              <span data-testid="collections-totals-cash-remainder" className="font-semibold text-text-primary tabular-nums">
                {formatCurrency(summary.totals.cashRemainder, locale)}
              </span>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
