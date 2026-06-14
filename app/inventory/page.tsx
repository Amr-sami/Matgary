// /inventory — Server Component shell.
//
// What this conversion does:
//   - Resolves dict + locale on the server.
//   - Renders AppShell + title server-side so the page chrome paints
//     on first byte without waiting for JS to hydrate.
//   - Delegates the entire interactive surface (search, filters,
//     sort, pagination, modals, bulk actions, scanner, quick-add)
//     to the InventoryClient island.
//
// What this conversion does NOT do:
//   - It does NOT render the product table server-side. The current
//     /inventory architecture filters/sorts/paginates IN-MEMORY over
//     the full product list returned by useProducts. Inlining 50K+
//     rows of HTML on every page mount would be orders of magnitude
//     bigger than the client fetch path. Converting the table to
//     SSR requires moving filtering/sorting to the server (cursor-
//     paginated reads + server-driven sort) — that's a Wave 4 item.

import { Suspense } from "react";
import { headers } from "next/headers";
import { AppShell } from "@/components/layout/AppShell";
import { InventoryClient } from "@/components/inventory/InventoryClient";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { defaultLocale, isLocale } from "@/lib/i18n/config";

export default async function InventoryPage() {
  const hdrs = await headers();
  const raw = hdrs.get("x-locale");
  const locale = raw && isLocale(raw) ? raw : defaultLocale;
  const dict = await getDictionary(locale);

  return (
    <AppShell title={dict.app.inventory.title}>
      <Suspense fallback={<PageSkeleton variant="grid" rows={8} cards={false} />}>
        <InventoryClient />
      </Suspense>
    </AppShell>
  );
}
