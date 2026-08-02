// Shared prop shapes for the deep-dive reports.

import type { InsightsWindow, InsightsBranchScope } from "@/hooks/useInsights";
import type { Locale } from "@/lib/i18n/config";

export interface DeepReportProps {
  window: InsightsWindow | undefined;
  branchScope: InsightsBranchScope;
  isOwner: boolean;
  locale: Locale;
  /** Called when a report wants to bubble an error up to the page's toast. */
  onError?: (message: string) => void;
}

export type ReportKey =
  | "compare"
  | "heatmap"
  | "payments"
  | "branches"
  | "product";

export const CHART_PALETTE = [
  "#1203E3",
  "#5B4DEC",
  "#22C55E",
  "#F59E0B",
  "#EF4444",
  "#0EA5E9",
  "#A855F7",
] as const;
