// Insights → Financials layout — a secondary tab bar for the four Financials
// sub-pages (Overview, P&L, Expenses, Money Movements). Lives under
// /insights/financials/* so the nav path matches the metaphor.

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { cn } from "@/lib/utils";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

const TAB_KEYS = [
  "overview",
  "pnl",
  "expenses",
  "moneyMovements",
  "recurring",
  "profitability",
] as const;
type TabKey = (typeof TAB_KEYS)[number];

const TAB_PATHS: Record<TabKey, string> = {
  overview: "/insights/financials/overview",
  pnl: "/insights/financials/pnl",
  expenses: "/insights/financials/expenses",
  moneyMovements: "/insights/financials/money-movements",
  recurring: "/insights/financials/recurring",
  profitability: "/insights/financials/profitability",
};

export default function FinancialsLayout({ children }: { children: ReactNode }) {
  const dict = useDictionary();
  const t = dict.app.financials;
  const pathname = usePathname() ?? "";
  const activeKey: TabKey =
    pathname.startsWith("/insights/financials/pnl")
      ? "pnl"
      : pathname.startsWith("/insights/financials/expenses")
        ? "expenses"
        : pathname.startsWith("/insights/financials/money-movements")
          ? "moneyMovements"
          : pathname.startsWith("/insights/financials/recurring")
            ? "recurring"
            : pathname.startsWith("/insights/financials/profitability")
              ? "profitability"
              : "overview";

  const tabs = TAB_KEYS.map((key) => ({
    key,
    label: (t.tabs as Record<TabKey, string>)[key],
    href: TAB_PATHS[key],
  }));

  return (
    <AppShell title={t.title}>
      <div className="space-y-5">
        <div className="space-y-1">
          <h2 className="text-2xl font-bold text-text-primary">{t.title}</h2>
          <p className="text-sm text-text-secondary">{t.subtitle}</p>
        </div>

        {/* Secondary tab bar — same visual language as the existing
            `Tabs` component but link-driven (URL is the source of truth). */}
        <nav
          role="tablist"
          className="flex items-center gap-1 overflow-x-auto bg-bg-card border border-border rounded-xl p-1"
        >
          {tabs.map((tab) => {
            const isActive = tab.key === activeKey;
            return (
              <Link
                key={tab.key}
                href={tab.href}
                role="tab"
                aria-selected={isActive}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors",
                  isActive
                    ? "bg-accent text-white"
                    : "text-text-secondary hover:bg-bg-main",
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        <div>{children}</div>
      </div>
    </AppShell>
  );
}
