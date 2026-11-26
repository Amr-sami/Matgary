// /expenses — Server Component.
//
// Page shell + heading render on the server. The interactive body
// (data fetch, form, table, toast) is the single client island
// ExpensesPageBody. Dictionary strings + locale are resolved at the
// SC layer and passed down explicitly so the island doesn't pay the
// context-subscription cost on hydration.

import { headers } from "next/headers";
import { AppShell } from "@/components/layout/AppShell";
import { ExpensesPageBody } from "@/components/expenses/ExpensesPageBody";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { defaultLocale, isLocale } from "@/lib/i18n/config";

export default async function ExpensesPage() {
  const hdrs = await headers();
  const raw = hdrs.get("x-locale");
  const locale = raw && isLocale(raw) ? raw : defaultLocale;
  const dict = await getDictionary(locale);
  const t = dict.app.expenses;

  return (
    <AppShell title={t.manageTitle}>
      <div className="space-y-6">
        <ExpensesPageBody
          locale={locale}
          strings={{
            summaryLabel: t.summary.label,
            listHeading: t.listHeading,
            addedToast: t.toast.added,
          }}
        />
      </div>
    </AppShell>
  );
}
