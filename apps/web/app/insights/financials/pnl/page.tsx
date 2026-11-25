// /insights/financials/pnl — the full Profit & Loss statement backed by
// GET /api/financials/pnl. OpEx hierarchy renders from the API response's
// `operatingExpensesByGroup` tree — no category tree duplicated in the UI.

"use client";

import { useState } from "react";
import { ChevronDown, ChevronLeft } from "@/lib/icons";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { formatCurrency } from "@/lib/i18n/format";
import { useLocale, useDictionary } from "@/components/i18n/DictionaryProvider";
import type { Locale } from "@/lib/i18n/config";
import { useFinancialPnL } from "@/hooks/useFinancials";
import { PresetChips } from "@/components/financials/PresetChips";
import type { DatePresetKey } from "@/lib/finance/dates";
import { cn } from "@/lib/utils";

export default function FinancialsPnLPage() {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.financials;
  const isRtl = locale === "ar";

  const [preset, setPreset] = useState<DatePresetKey>("this_month");
  const { data: payload, loading, error, forbidden, refresh } = useFinancialPnL({
    preset,
  });

  return (
    <div className="space-y-5">
      <PresetChips value={preset} onChange={setPreset} />

      {forbidden ? (
        <ForbiddenPanel />
      ) : loading && !payload ? (
        <PageSkeleton rows={10} />
      ) : error && !payload ? (
        <ErrorPanel message={error} onRetry={refresh} />
      ) : !payload ? (
        <EmptyPanel />
      ) : (
        <PnLStatement payload={payload} isRtl={isRtl} />
      )}
    </div>
  );
}

function PnLStatement({
  payload,
  isRtl,
}: {
  payload: NonNullable<ReturnType<typeof useFinancialPnL>["data"]>;
  isRtl: boolean;
}) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.financials;
  const pnl = payload.data;
  const seesProfit = payload.seesProfit;

  const fmt = (n: number) => formatCurrency(n, locale);
  const marginPct = (n: number) => `${(n * 100).toFixed(1)}${t.margin.unit}`;

  return (
    <div className="bg-white rounded-xl border border-border overflow-hidden">
      {/* Revenue */}
      <Section title={t.pnl.sectionRevenue}>
        <Row label={t.pnl.rowGrossSales} value={fmt(pnl.grossSales)} />
        <Row
          label={t.pnl.rowDiscounts}
          value={`− ${fmt(pnl.discounts)}`}
          negative={pnl.discounts > 0}
        />
        <Row
          label={t.pnl.rowReturns}
          value={`− ${fmt(pnl.returnsRevenue)}`}
          negative={pnl.returnsRevenue > 0}
        />
        <Divider />
        <Row label={t.pnl.rowNetSales} value={fmt(pnl.netSales)} emphasized />
      </Section>

      <Divider />

      {/* COGS */}
      <Section title={t.pnl.sectionCogs}>
        <Row label={t.pnl.rowProductCosts} value={fmt(pnl.cogs)} />
        <Divider />
        {seesProfit && pnl.grossProfit !== null ? (
          <Row
            label={t.pnl.rowGrossProfit}
            value={fmt(pnl.grossProfit)}
            emphasized
            positive={pnl.grossProfit >= 0}
          />
        ) : (
          <RedactedRow label={t.pnl.rowGrossProfit} />
        )}
      </Section>

      <Divider />

      {/* Operating Expenses (hierarchical) */}
      <Section title={t.pnl.sectionOpex}>
        {pnl.operatingExpensesByGroup.length === 0 ? (
          <p className="text-sm text-text-secondary">{t.pnl.emptyGroup}</p>
        ) : (
          <div className="space-y-1">
            {pnl.operatingExpensesByGroup.map((group) => (
              <GroupRow
                key={group.groupSlug}
                group={group}
                locale={locale}
                isRtl={isRtl}
              />
            ))}
          </div>
        )}
        <Divider />
        <Row label={t.pnl.rowTotalOpex} value={fmt(pnl.operatingExpenses)} />
        {seesProfit && pnl.operatingProfit !== null ? (
          <Row
            label={t.pnl.rowOperatingProfit}
            value={fmt(pnl.operatingProfit)}
            emphasized
            positive={pnl.operatingProfit >= 0}
          />
        ) : (
          <RedactedRow label={t.pnl.rowOperatingProfit} />
        )}
      </Section>

      <Divider />

      {/* Other income / expense + Net Profit */}
      <Section title={t.pnl.sectionOther}>
        <Row label={t.pnl.rowOtherIncome} value={fmt(pnl.otherIncome)} />
        <Row
          label={t.pnl.rowOtherExpense}
          value={`− ${fmt(pnl.otherExpense)}`}
          negative={pnl.otherExpense > 0}
        />
        <Divider />
        {seesProfit && pnl.netProfit !== null ? (
          <>
            <Row
              label={t.pnl.rowNetProfit}
              value={fmt(pnl.netProfit)}
              emphasized
              positive={pnl.netProfit >= 0}
            />
            {pnl.netMargin !== null && (
              <Row
                label={t.pnl.rowNetMargin}
                value={marginPct(pnl.netMargin)}
                emphasized={false}
              />
            )}
          </>
        ) : (
          <RedactedRow label={t.pnl.rowNetProfit} />
        )}
        {!seesProfit && (
          <p className="text-xs text-text-secondary pt-2 border-t border-border">
            {t.pnl.profitRedacted}
          </p>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="p-5 space-y-2">
      <h3 className="text-xs uppercase tracking-wider text-text-secondary font-semibold">
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Divider() {
  return <div className="h-px bg-border" />;
}

function Row({
  label,
  value,
  negative,
  emphasized,
  positive,
  indent,
}: {
  label: string;
  value: string;
  negative?: boolean;
  emphasized?: boolean;
  positive?: boolean;
  indent?: 0 | 1 | 2;
}) {
  const paddingStart = indent === 2 ? "ps-8" : indent === 1 ? "ps-4" : "";
  return (
    <div className={cn("flex items-center justify-between text-sm", paddingStart)}>
      <span
        className={emphasized ? "font-semibold text-text-primary" : "text-text-secondary"}
      >
        {label}
      </span>
      <span
        className={
          "tabular-nums " +
          (emphasized
            ? positive === true
              ? "font-bold text-success"
              : positive === false
                ? "font-bold text-danger"
                : "font-bold text-text-primary"
            : negative
              ? "text-danger"
              : "font-medium text-text-primary")
        }
      >
        {value}
      </span>
    </div>
  );
}

function RedactedRow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="font-semibold text-text-primary">{label}</span>
      <span className="text-text-secondary">—</span>
    </div>
  );
}

function GroupRow({
  group,
  locale,
  isRtl,
}: {
  group: NonNullable<ReturnType<typeof useFinancialPnL>["data"]>["data"]["operatingExpensesByGroup"][number];
  locale: Locale;
  isRtl: boolean;
}) {
  const [open, setOpen] = useState(false);
  const fmt = (n: number) => formatCurrency(n, locale);
  const Chevron = open ? ChevronDown : ChevronLeft;
  const groupLabel = isRtl ? group.groupNameAr : group.groupNameEn;

  return (
    <div className="rounded-lg hover:bg-bg-main transition-colors">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between py-2 px-2 text-sm"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-text-primary">
          <Chevron className="w-4 h-4 text-text-secondary" />
          <span className="font-medium">{groupLabel}</span>
        </span>
        <span className="tabular-nums font-medium">{fmt(group.total)}</span>
      </button>
      {open && (
        <ul className="pb-2 space-y-1">
          {group.categories.map((cat) => {
            const subLabel = isRtl ? cat.nameAr : cat.nameEn;
            return (
              <li
                key={`${cat.categoryId ?? cat.slug}-${subLabel}`}
                className="flex items-center justify-between text-xs ps-8 pe-2"
              >
                <span className="text-text-secondary">{subLabel}</span>
                <span className="tabular-nums text-text-primary">{fmt(cat.amount)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ForbiddenPanel() {
  const locale = useLocale();
  const title = locale === "ar" ? "ليست لديك صلاحية الوصول" : "You don't have access";
  const hint =
    locale === "ar"
      ? "تحتاج صلاحية view_financials للوصول إلى هذه الصفحة."
      : "You need the view_financials permission to open this page.";
  return (
    <div className="bg-white rounded-xl border border-border p-8 text-center space-y-2">
      <h3 className="font-semibold text-text-primary">{title}</h3>
      <p className="text-sm text-text-secondary">{hint}</p>
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  const dict = useDictionary();
  const t = dict.app.financials.error;
  return (
    <div className="bg-white rounded-xl border border-danger-light p-8 text-center space-y-3">
      <h3 className="font-semibold text-danger">{t.title}</h3>
      <p className="text-sm text-text-secondary">{t.hint}</p>
      <p className="text-xs text-text-secondary font-mono">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="px-4 py-2 rounded-lg border border-border bg-white hover:bg-bg-main text-sm"
      >
        {t.retry}
      </button>
    </div>
  );
}

function EmptyPanel() {
  const dict = useDictionary();
  const t = dict.app.financials.empty;
  return (
    <div className="bg-white rounded-xl border border-border p-8 text-center space-y-2">
      <h3 className="font-semibold text-text-primary">{t.title}</h3>
      <p className="text-sm text-text-secondary">{t.hint}</p>
    </div>
  );
}
