"use client";

/**
 * Container for the "Deep dive" tab inside /insights.
 *
 * Renders a report picker (pill row) and one of five reports underneath:
 *   • compare   — current window vs previous window overlay
 *   • heatmap   — hour × day-of-week grid
 *   • payments  — stacked bar of revenue by payment method per day
 *   • branches  — owner-only side-by-side branch comparison
 *   • product   — searchable product drill-down
 *
 * Window + branch scope come from the parent page (shared with the Overview
 * tab so switching tabs doesn't lose the user's filter selections).
 */

import { useState } from "react";
import {
  Calendar,
  LayoutGrid,
  ArrowDownToLine,
  Package,
  BarChart3,
} from "@/lib/icons";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { ComparePeriodsReport } from "./ComparePeriodsReport";
import { TimeHeatmapReport } from "./TimeHeatmapReport";
import { PaymentMixReport } from "./PaymentMixReport";
import { BranchComparisonReport } from "./BranchComparisonReport";
import { ProductDrillDownReport } from "./ProductDrillDownReport";
import type { DeepReportProps, ReportKey } from "./types";

interface DeepDiveProps extends Omit<DeepReportProps, "onError"> {
  /** Optional. If omitted the picker defaults to "compare". */
  initialReport?: ReportKey;
}

interface PickerItem {
  key: ReportKey;
  label: string;
  hint: string;
  Icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
  disabledReason?: string;
}

export function DeepDive({
  window,
  branchScope,
  isOwner,
  locale,
  initialReport,
}: DeepDiveProps) {
  const dict = useDictionary();
  const t = dict.app.insights.deep;
  const [report, setReport] = useState<ReportKey>(initialReport ?? "compare");

  const items: PickerItem[] = [
    {
      key: "compare",
      label: t.picker.compare.label,
      hint: t.picker.compare.hint,
      Icon: BarChart3,
    },
    {
      key: "heatmap",
      label: t.picker.heatmap.label,
      hint: t.picker.heatmap.hint,
      Icon: LayoutGrid,
    },
    {
      key: "payments",
      label: t.picker.payments.label,
      hint: t.picker.payments.hint,
      Icon: ArrowDownToLine,
    },
    {
      key: "branches",
      label: t.picker.branches.label,
      hint: t.picker.branches.hint,
      Icon: Calendar,
      disabled: !isOwner,
      disabledReason: t.picker.branches.ownerOnly,
    },
    {
      key: "product",
      label: t.picker.product.label,
      hint: t.picker.product.hint,
      Icon: Package,
    },
  ];

  return (
    <div className="space-y-4">
      {/* Report picker — one card each so the user gets both the title and
          a one-line rationale for why they might pick it. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {items.map((item) => {
          const active = item.key === report;
          const disabled = item.disabled;
          return (
            <button
              key={item.key}
              type="button"
              disabled={disabled}
              onClick={() => !disabled && setReport(item.key)}
              className={[
                "text-start rounded-xl border p-3 transition-colors",
                disabled
                  ? "border-border bg-bg-main/30 text-text-secondary opacity-60 cursor-not-allowed"
                  : active
                    ? "border-accent bg-accent-light/60 text-accent"
                    : "border-border bg-white hover:border-accent hover:bg-accent-light/30 text-text-primary",
              ].join(" ")}
              title={disabled ? item.disabledReason : undefined}
            >
              <div className="flex items-center gap-2">
                <item.Icon
                  className={`w-4 h-4 ${
                    active && !disabled ? "text-accent" : "text-text-secondary"
                  }`}
                />
                <span className="text-sm font-semibold">{item.label}</span>
              </div>
              <p className="text-[11px] text-text-secondary mt-1 leading-snug">
                {disabled && item.disabledReason
                  ? item.disabledReason
                  : item.hint}
              </p>
            </button>
          );
        })}
      </div>

      {report === "compare" && (
        <ComparePeriodsReport
          window={window}
          branchScope={branchScope}
          isOwner={isOwner}
          locale={locale}
        />
      )}
      {report === "heatmap" && (
        <TimeHeatmapReport
          window={window}
          branchScope={branchScope}
          isOwner={isOwner}
          locale={locale}
        />
      )}
      {report === "payments" && (
        <PaymentMixReport
          window={window}
          branchScope={branchScope}
          isOwner={isOwner}
          locale={locale}
        />
      )}
      {report === "branches" && (
        <BranchComparisonReport
          window={window}
          branchScope={branchScope}
          isOwner={isOwner}
          locale={locale}
        />
      )}
      {report === "product" && (
        <ProductDrillDownReport
          window={window}
          branchScope={branchScope}
          isOwner={isOwner}
          locale={locale}
        />
      )}
    </div>
  );
}
