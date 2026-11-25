// /insights/financials/profitability — product + category profit tables.
// Server is the single source of truth (lib/finance/profitability.ts).
// view_profit callers see profit/margin; others see revenue+units only.

"use client";

import { useState } from "react";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatCurrency } from "@/lib/i18n/format";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import type { Locale } from "@/lib/i18n/config";
import { PresetChips } from "@/components/financials/PresetChips";
import {
  useCategoryProfitability,
  useProductProfitability,
  type ProfitabilitySort,
} from "@/hooks/useFinancials";
import type { DatePresetKey } from "@/lib/finance/dates";

export default function FinancialsProfitabilityPage() {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.financials;

  const [preset, setPreset] = useState<DatePresetKey>("this_month");
  const [sort, setSort] = useState<ProfitabilitySort>("grossProfit");
  const [search, setSearch] = useState("");

  const products = useProductProfitability({
    preset,
    sort,
    search: search.trim() || undefined,
    limit: 100,
  });
  const cats = useCategoryProfitability({ preset, sort });

  return (
    <div className="space-y-5">
      <PresetChips value={preset} onChange={setPreset} />

      {products.forbidden ? (
        <ForbiddenPanel />
      ) : (
        <>
          <section>
            <SectionHeader
              title={locale === "ar" ? "ربحية الفئات" : "Category profitability"}
              sort={sort}
              setSort={setSort}
            />
            {cats.loading && !cats.data ? (
              <PageSkeleton rows={5} />
            ) : !cats.data || cats.data.rows.length === 0 ? (
              <EmptyState type="sales" message={t.empty.hint} />
            ) : (
              <ProfTable
                rows={cats.data.rows.map((r) => ({
                  key: r.categoryId,
                  nameEn: r.categoryLabel ?? r.categoryId,
                  nameAr: r.categoryLabel ?? r.categoryId,
                  sub: null,
                  quantitySold: r.quantitySold,
                  revenue: r.revenue,
                  cogs: r.cogs,
                  grossProfit: r.grossProfit,
                  margin: r.margin,
                }))}
                locale={locale}
                seesProfit={cats.data.seesProfit}
              />
            )}
          </section>

          <section>
            <SectionHeader
              title={locale === "ar" ? "ربحية المنتجات" : "Product profitability"}
              sort={sort}
              setSort={setSort}
            />
            <Input
              placeholder={
                locale === "ar"
                  ? "بحث باسم المنتج"
                  : "Search by product name"
              }
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {products.loading && !products.data ? (
              <PageSkeleton rows={8} />
            ) : !products.data || products.data.rows.length === 0 ? (
              <EmptyState type="sales" message={t.empty.hint} />
            ) : (
              <ProfTable
                rows={products.data.rows.map((r) => ({
                  key: r.productId,
                  nameEn: r.productName,
                  nameAr: r.productName,
                  sub: r.brand ?? null,
                  quantitySold: r.quantitySold,
                  revenue: r.revenue,
                  cogs: r.cogs,
                  grossProfit: r.grossProfit,
                  margin: r.margin,
                }))}
                locale={locale}
                seesProfit={products.data.seesProfit}
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}

function SectionHeader({
  title,
  sort,
  setSort,
}: {
  title: string;
  sort: ProfitabilitySort;
  setSort: (s: ProfitabilitySort) => void;
}) {
  const locale = useLocale();
  return (
    <div className="flex items-end justify-between gap-3 mb-3">
      <h3 className="text-base font-semibold text-text-primary">{title}</h3>
      <div className="w-[200px]">
        <Select
          label={locale === "ar" ? "ترتيب" : "Sort"}
          value={sort}
          onChange={(e) => setSort(e.target.value as ProfitabilitySort)}
          options={[
            { value: "grossProfit", label: locale === "ar" ? "الربح الإجمالي" : "Gross profit" },
            { value: "revenue", label: locale === "ar" ? "الإيرادات" : "Revenue" },
            { value: "margin", label: locale === "ar" ? "الهامش" : "Margin" },
            { value: "quantity", label: locale === "ar" ? "الكمية" : "Quantity" },
          ]}
        />
      </div>
    </div>
  );
}

interface ProfTableRow {
  key: string;
  nameEn: string;
  nameAr: string;
  sub: string | null;
  quantitySold: number;
  revenue: number;
  cogs: number | null;
  grossProfit: number | null;
  margin: number | null;
}

function ProfTable({
  rows,
  locale,
  seesProfit,
}: {
  rows: ProfTableRow[];
  locale: Locale;
  seesProfit: boolean;
}) {
  const isRtl = locale === "ar";
  return (
    <div className="bg-white rounded-xl border border-border overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-main text-text-secondary text-xs uppercase">
            <tr>
              <th className="text-start px-4 py-3">
                {locale === "ar" ? "الاسم" : "Name"}
              </th>
              <th className="text-end px-4 py-3">
                {locale === "ar" ? "الكمية" : "Qty"}
              </th>
              <th className="text-end px-4 py-3">
                {locale === "ar" ? "الإيرادات" : "Revenue"}
              </th>
              <th className="text-end px-4 py-3">
                {locale === "ar" ? "التكلفة" : "COGS"}
              </th>
              <th className="text-end px-4 py-3">
                {locale === "ar" ? "ربح إجمالي" : "Gross profit"}
              </th>
              <th className="text-end px-4 py-3">
                {locale === "ar" ? "هامش" : "Margin"}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-border">
                <td className="px-4 py-3">
                  <div className="font-medium text-text-primary">
                    {isRtl ? r.nameAr : r.nameEn}
                  </div>
                  {r.sub && (
                    <div className="text-xs text-text-secondary">{r.sub}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-end tabular-nums">
                  {r.quantitySold}
                </td>
                <td className="px-4 py-3 text-end tabular-nums">
                  {formatCurrency(r.revenue, locale)}
                </td>
                <td className="px-4 py-3 text-end tabular-nums">
                  {seesProfit && r.cogs !== null
                    ? formatCurrency(r.cogs, locale)
                    : "—"}
                </td>
                <td className="px-4 py-3 text-end tabular-nums font-medium">
                  {seesProfit && r.grossProfit !== null
                    ? formatCurrency(r.grossProfit, locale)
                    : "—"}
                </td>
                <td className="px-4 py-3 text-end">
                  {seesProfit && r.margin !== null ? (
                    <Badge
                      variant={
                        r.margin >= 0.5
                          ? "sold"
                          : r.margin >= 0.2
                            ? "lowstock"
                            : r.margin >= 0
                              ? "other"
                              : "returned"
                      }
                    >
                      {(r.margin * 100).toFixed(1)}%
                    </Badge>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ForbiddenPanel() {
  const locale = useLocale();
  const title = locale === "ar" ? "ليست لديك صلاحية الوصول" : "You don't have access";
  const hint =
    locale === "ar"
      ? "تحتاج صلاحية view_financials."
      : "You need the view_financials permission.";
  return (
    <div className="bg-white rounded-xl border border-border p-8 text-center space-y-2">
      <h3 className="font-semibold text-text-primary">{title}</h3>
      <p className="text-sm text-text-secondary">{hint}</p>
    </div>
  );
}
