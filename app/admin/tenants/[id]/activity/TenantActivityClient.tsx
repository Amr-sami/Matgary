"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

interface ActivityRow {
  id: string;
  actorName: string | null;
  action: string;
  category: string;
  entityType: string | null;
  entityLabel: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

export function TenantActivityClient({ id }: { id: string }) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.admin.tenants.activity;
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const dateLocale = locale === "ar" ? "ar-EG" : "en-US";

  useEffect(() => {
    fetch(`/api/admin/tenants/${id}/activity?limit=500`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((j) => setRows(j.data ?? []))
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <Link href={`/admin/tenants/${id}`} className="text-sm text-accent">
        {t.back}
      </Link>
      <header>
        <h1 className="text-2xl font-bold">{t.title}</h1>
        <p className="text-sm text-text-secondary mt-1">{t.subtitle}</p>
      </header>

      {loading ? (
        <p className="text-sm text-text-secondary text-center py-8">…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-text-secondary text-center py-8">—</p>
      ) : (
        <ul className="bg-white rounded-2xl border border-border divide-y divide-border">
          {rows.map((r) => (
            <li key={r.id} className="px-4 py-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] bg-bg-main rounded px-1.5 py-0.5">
                  {r.action}
                </span>
                {r.entityLabel && (
                  <span className="text-text-secondary text-xs" dir="auto">
                    {r.entityLabel}
                  </span>
                )}
              </div>
              <p className="text-xs text-text-secondary mt-1">
                {r.actorName ?? "—"} · {new Date(r.createdAt).toLocaleString(dateLocale)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
