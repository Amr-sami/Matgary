import type { ApiClient } from "../http";

/**
 * Scheduled report payloads. Mirrors the server's
 * apps/web/app/api/reports/<kind>/route.ts, which itself is a thin wrapper
 * over `loadInsightsOverview` — the same numbers the Insights dashboard shows
 * for the same window. Adding a metric here means adding it there too.
 */
export interface ReportOverview {
  window: { from: string; to: string } | null;
  metrics: {
    currentRevenue: number;
    lastRevenue: number;
    revenueGrowth: number;
    totalRevenue: number;
    totalCostOfGoods: number;
    totalExpenses: number;
    grossProfit: number;
    netProfit: number;
    totalDiscounts: number;
    discountPercent: number;
    totalSales: number;
    totalReturns: number;
  };
  trendData: Array<{ date: string; revenue: number; count: number }>;
  topProducts: Array<{
    id: string;
    name: string;
    brand: string | null;
    qty: number;
    revenue: number;
  }>;
  categoryChartData: Array<{ name: string; value: number }>;
}

export interface WeeklyReportResponse {
  kind: "weekly";
  period: string;
  window: { from: string; to: string; year: number; week: number };
  overview: ReportOverview;
}

export interface MonthlyReportResponse {
  kind: "monthly";
  period: string;
  window: { from: string; to: string; year: number; month: number };
  overview: ReportOverview;
}

export async function getWeekly(c: ApiClient, period: string): Promise<WeeklyReportResponse> {
  return c.request<WeeklyReportResponse>("/api/reports/weekly", {
    query: { period },
  });
}

export async function getMonthly(c: ApiClient, period: string): Promise<MonthlyReportResponse> {
  return c.request<MonthlyReportResponse>("/api/reports/monthly", {
    query: { period },
  });
}

/** Developer / cron trigger — dispatches the weekly report push to the owner. */
export async function sendWeekly(
  c: ApiClient,
  input: { period?: string } = {},
): Promise<{ ok: true; period: string }> {
  return c.request<{ ok: true; period: string }>("/api/reports/weekly/send", {
    method: "POST",
    body: input,
  });
}

/** Developer / cron trigger — dispatches the monthly report push to the owner. */
export async function sendMonthly(
  c: ApiClient,
  input: { period?: string } = {},
): Promise<{ ok: true; period: string }> {
  return c.request<{ ok: true; period: string }>("/api/reports/monthly/send", {
    method: "POST",
    body: input,
  });
}
