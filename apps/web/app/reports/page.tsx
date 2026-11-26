// /reports — Server Component.
//
// Page shell + dictionary resolution on the server. Everything else
// (date range state, useSales/useReturns aggregation, print state,
// table, summary cards) lives in the ReportsPageBody client island.

import { Suspense } from "react";
import { headers } from "next/headers";
import { AppShell } from "@/components/layout/AppShell";
import { ReportsPageBody } from "@/components/reports/ReportsPageBody";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { defaultLocale, isLocale } from "@/lib/i18n/config";

export default async function ReportsPage() {
  const hdrs = await headers();
  const raw = hdrs.get("x-locale");
  const locale = raw && isLocale(raw) ? raw : defaultLocale;
  const dict = await getDictionary(locale);
  const t = dict.app.reports;

  return (
    <AppShell title={t.title}>
      <Suspense fallback={<PageSkeleton chart rows={6} />}>
        <ReportsPageBody
          locale={locale}
          strings={{
            totalSales: t.totalSales,
            totalQty: t.totalQty,
            qtySuffix: t.qtySuffix,
            totalReturns: t.totalReturns,
            returnsSubtitle: t.returnsSubtitle,
            detailsHeading: t.detailsHeading,
          }}
        />
      </Suspense>
    </AppShell>
  );
}
