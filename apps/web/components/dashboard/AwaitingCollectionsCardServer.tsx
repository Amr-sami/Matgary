// Digital collections — the dashboard "awaiting confirmation" card
// (mobile-dev-docs/15-digital-collections/13 §4.12). Server Component,
// streamed behind its own <Suspense> like the other dashboard widgets.
//
// Visibility is decided here, server-side (03 §E.5: totals only to
// view_collections): the owner, or staff holding `view_collections`, and only
// when Collections is on for the scope — `features.collections` for a branch,
// `collectionsTenantAdmitted` for "all branches". Renders nothing when
// nothing is pending.

import "server-only";
import Link from "next/link";
import { collectionsTenantAdmitted, resolveCollectionsFeatures } from "@/lib/collections/flags";
import { loadAwaitingCollections } from "@/lib/repo/insights";
import { formatCurrency } from "@/lib/i18n/format";
import type { Dictionary } from "@/lib/i18n/get-dictionary";
import type { Locale } from "@/lib/i18n/config";
import { Wallet } from "@/lib/icons";

interface AwaitingCollectionsCardServerProps {
  tenantId: string;
  branchId: string | null;
  role: string | null;
  permissions: readonly string[];
  dict: Dictionary;
  locale: Locale;
}

export async function AwaitingCollectionsCardServer({
  tenantId,
  branchId,
  role,
  permissions,
  dict,
  locale,
}: AwaitingCollectionsCardServerProps) {
  const allowed = role === "owner" || permissions.includes("view_collections");
  if (!allowed) return null;
  const on = branchId
    ? (await resolveCollectionsFeatures(tenantId, branchId)).collections
    : collectionsTenantAdmitted(tenantId);
  if (!on) return null;

  const data = await loadAwaitingCollections(tenantId, branchId);
  if (data.count === 0) return null;

  const t = dict.app.dashboard.collections;
  const href = data.staleCount > 0 ? "/collections?status=pending&stale=1" : "/collections";
  return (
    <Link
      href={href}
      data-testid="dashboard-collections-awaiting"
      className="flex items-center gap-4 bg-white rounded-xl p-5 shadow-sm border border-border hover:border-accent/40 transition-colors"
    >
      <span className="shrink-0 w-11 h-11 rounded-full bg-accent-light text-accent flex items-center justify-center">
        <Wallet className="w-5 h-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-text-primary">{t.title}</p>
        <p className="text-sm text-text-secondary tabular-nums mt-0.5">
          {t.summary
            .replace("{count}", String(data.count))
            .replace("{amount}", formatCurrency(data.amount, locale))}
          {data.staleCount > 0 && (
            <span className="ms-2 inline-flex items-center rounded-full bg-orange-50 text-orange-700 px-2 py-0.5 text-xs font-medium">
              {t.stale.replace("{n}", String(data.staleCount))}
            </span>
          )}
        </p>
      </div>
      <span className="shrink-0 text-sm font-medium text-accent">{t.open}</span>
    </Link>
  );
}
