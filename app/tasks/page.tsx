// /tasks — Server Component.
//
// Page shell + heading render on the server with the dictionary
// resolved at the SC layer (no `useDictionary` call). The interactive
// surface (toast state + badge invalidation + TasksTab) lives in the
// small `TasksPageBody` client island.

import { headers } from "next/headers";
import { AppShell } from "@/components/layout/AppShell";
import { TasksPageBody } from "@/components/tasks/TasksPageBody";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { defaultLocale, isLocale } from "@/lib/i18n/config";

export default async function TasksPage() {
  const hdrs = await headers();
  const raw = hdrs.get("x-locale");
  const locale = raw && isLocale(raw) ? raw : defaultLocale;
  const dict = await getDictionary(locale);
  const t = dict.app.tasks.page;

  return (
    <AppShell title={t.title}>
      <div className="max-w-5xl mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-bold text-text-primary leading-tight">
            {t.heading}
          </h1>
          <p className="text-sm text-text-secondary mt-0.5">{t.subhead}</p>
        </header>

        <TasksPageBody />
      </div>
    </AppShell>
  );
}
