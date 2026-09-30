"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { Button } from "@/components/ui/Button";
import { Toast } from "@/components/ui/Toast";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { useBranches } from "@/hooks/useBranches";
import {
  useActiveBranchId,
  useCollectionsAccess,
  useCollectionsList,
  useCollectionsSummary,
} from "@/hooks/useCollections";
import { CollectionRow } from "@/components/collections/CollectionRow";
import { CollectionDetailModal, useOnline } from "@/components/collections/CollectionDetailModal";
import { DailyTotalsTable } from "@/components/collections/DailyTotalsTable";
import { localYmd, listQueryFor, parseInboxParams, type InboxTab } from "@/components/collections/rules";
import { cn } from "@/lib/utils";

// The Collections inbox (doc 15 spec 12 §4.7). The URL is the state, so the
// notification links of 03 §B.6 open the right tab unchanged:
// /collections?status=pending · ?status=pending&stale=1 · ?tab=credits ·
// ?tab=totals. `useSearchParams` needs the Suspense boundary below or
// `next build` bails out of prerendering (Next 16 use-search-params.md).

export default function CollectionsPage() {
  const dict = useDictionary();
  return (
    <Suspense
      fallback={
        <AppShell title={dict.app.collections.inbox.title}>
          <PageSkeleton variant="list" />
        </AppShell>
      }
    >
      <CollectionsPageInner />
    </Suspense>
  );
}

function shiftDay(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  return localYmd(new Date(y, m - 1, d + delta));
}

function CollectionsPageInner() {
  const dict = useDictionary();
  const router = useRouter();
  const sp = useSearchParams();
  const inbox = dict.app.collections.inbox;
  const web = dict.app.collections.web;
  const totalsT = dict.app.collections.totals;
  const access = useCollectionsAccess();
  const { features, canView, canManage, isOwner, loading } = access;
  const activeBranchId = useActiveBranchId();
  const { branches } = useBranches();
  const ingestOn = features.collectionsIngest;

  const params = useMemo(
    () => parseInboxParams(sp, ingestOn, { isOwner }),
    [sp, ingestOn, isOwner],
  );
  const today = localYmd(new Date());

  /** Write the URL (the single source of state). */
  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(sp.toString());
      // `status` is only an alias for the pending tab (notification links).
      next.delete("status");
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(qs ? `/collections?${qs}` : "/collections", { scroll: false });
    },
    [router, sp],
  );

  const listQuery = listQueryFor(params.tab, params);
  const listEnabled = features.collections && canView && listQuery != null;
  const list = useCollectionsList(listQuery, listEnabled);
  // The pending badge on the tab: counts of the same scope (any list page).
  const countsQuery = useCollectionsList(
    { status: "pending", order: "asc", ...(params.allBranches ? { branchId: "all" } : {}) },
    features.collections && canView && params.tab !== "pending",
  );
  const counts = (params.tab === "pending" ? list.data : countsQuery.data)?.pages[0]?.counts ?? null;
  const summary = useCollectionsSummary(
    params.date,
    params.allBranches ? "all" : activeBranchId,
    features.collections && canView && params.tab === "totals",
  );

  const [toast, setToast] = useState<string | null>(null);
  const online = useOnline();

  const rows = useMemo(() => {
    const all = list.data?.pages.flatMap((p) => p.data) ?? [];
    // R8 guard: an older server that ignores `invoiceId` must not show
    // other invoices under the invoice chip.
    return params.invoice ? all.filter((c) => c.invoiceId === params.invoice) : all;
  }, [list.data, params.invoice]);

  const branchName = useCallback(
    (id: string) => branches.find((b) => b.id === id)?.name ?? null,
    [branches],
  );

  // ---- States -------------------------------------------------------------
  if (loading) {
    return (
      <AppShell title={inbox.title}>
        <PageSkeleton variant="list" />
      </AppShell>
    );
  }
  if (!features.collections) {
    return (
      <AppShell title={inbox.title}>
        <div
          data-testid="collections-feature-off"
          className="max-w-lg mx-auto mt-8 bg-white rounded-2xl border border-border p-6 text-center space-y-2"
        >
          <h2 className="text-base font-semibold text-text-primary">{inbox.featureOff.title}</h2>
          {canManage && features.collectionsAvailable ? (
            <Link href="/settings/collections" className="text-sm text-accent hover:underline">
              {inbox.featureOff.ownerHint}
            </Link>
          ) : (
            <p className="text-sm text-text-secondary">{inbox.featureOff.staffHint}</p>
          )}
        </div>
      </AppShell>
    );
  }
  if (!canView) {
    return (
      <AppShell title={inbox.title}>
        <div
          data-testid="collections-denied"
          className="max-w-lg mx-auto mt-8 bg-white rounded-2xl border border-border p-6 text-center space-y-2"
        >
          <h2 className="text-base font-semibold text-text-primary">{inbox.denied.title}</h2>
          <p className="text-sm text-text-secondary">{inbox.denied.hint}</p>
        </div>
      </AppShell>
    );
  }

  const tabLabels = inbox.tabs as Record<string, string>;
  const tabs: TabItem<InboxTab>[] = [
    { key: "pending", label: tabLabels.pending, badge: counts && counts.pending > 0 ? counts.pending : undefined },
    ...(ingestOn ? [{ key: "credits" as const, label: tabLabels.credits ?? "credits" }] : []),
    { key: "confirmed", label: tabLabels.confirmed },
    { key: "rejected", label: tabLabels.rejected },
    { key: "totals", label: tabLabels.totals },
  ];
  const multiBranch = isOwner && branches.length > 1;
  const emptyCopy = (inbox.empty as Record<string, { title: string; hint?: string }>)[params.tab];

  return (
    <AppShell title={inbox.title}>
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">{inbox.subtitle}</p>

        <Tabs
          items={tabs}
          active={params.tab}
          onChange={(k) => setParams({ tab: k === "pending" ? null : k, stale: null, id: null })}
          testIdPrefix="collections-tab-"
          className="[&>button]:min-h-11 lg:[&>button]:min-h-0"
        />

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          {params.tab === "pending" && (
            <label
              data-testid="collections-stale-only"
              className={cn(
                "inline-flex items-center gap-2 min-h-11 px-3 rounded-lg border text-sm cursor-pointer",
                params.stale ? "border-danger bg-danger-light text-danger" : "border-border bg-white text-text-secondary",
              )}
            >
              <input
                type="checkbox"
                checked={params.stale}
                onChange={(e) => setParams({ stale: e.target.checked ? "1" : null })}
                className="w-4 h-4 accent-accent"
              />
              {inbox.staleOnly}
              {counts && counts.stale > 0 && <span className="text-xs font-bold">({counts.stale})</span>}
            </label>
          )}
          {multiBranch && (
            <div className="inline-flex rounded-lg border border-border overflow-hidden" role="group" aria-label={web.inbox.branch}>
              <button
                type="button"
                data-testid="collections-branch-this"
                aria-pressed={!params.allBranches}
                onClick={() => setParams({ branch: null })}
                className={cn("min-h-11 px-3 text-sm", !params.allBranches ? "bg-accent text-white" : "bg-white text-text-secondary")}
              >
                {web.inbox.branchScope.this}
              </button>
              <button
                type="button"
                data-testid="collections-branch-all"
                aria-pressed={params.allBranches}
                onClick={() => setParams({ branch: "all" })}
                className={cn("min-h-11 px-3 text-sm", params.allBranches ? "bg-accent text-white" : "bg-white text-text-secondary")}
              >
                {web.inbox.branchScope.all}
              </button>
            </div>
          )}
          {params.invoice && (
            <span className="inline-flex items-center gap-2 min-h-11 px-3 rounded-lg bg-accent-light text-accent text-sm">
              <span dir="auto">{web.inbox.invoiceFilter.replace("{invoice}", params.invoice)}</span>
              <button
                type="button"
                data-testid="collections-invoice-filter-clear"
                onClick={() => setParams({ invoice: null })}
                className="text-xs font-semibold underline"
              >
                {web.inbox.clearFilter}
              </button>
            </span>
          )}
          {params.tab === "pending" && (
            <span className="text-xs text-text-secondary ms-auto">{web.inbox.oldestFirst}</span>
          )}
        </div>

        {/* Body */}
        {params.tab === "totals" ? (
          <div className="bg-white rounded-2xl border border-border overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border">
              <h2 className="text-sm font-semibold text-text-primary me-auto">{totalsT.title}</h2>
              <button
                type="button"
                data-testid="collections-totals-date-prev"
                onClick={() => setParams({ date: shiftDay(params.date, -1) })}
                className="min-h-11 px-3 rounded-lg border border-border text-sm text-text-secondary hover:border-accent/50"
                aria-label={totalsT.prevDay}
              >
                {totalsT.prevDay}
              </button>
              <input
                type="date"
                data-testid="collections-totals-date"
                value={params.date}
                max={today}
                aria-label={web.totals.date}
                onChange={(e) => e.target.value && setParams({ date: e.target.value === today ? null : e.target.value })}
                className="min-h-11 px-3 rounded-lg border border-border bg-white text-sm"
                dir="ltr"
              />
              <button
                type="button"
                data-testid="collections-totals-date-next"
                disabled={params.date >= today}
                onClick={() => {
                  const next = shiftDay(params.date, 1);
                  setParams({ date: next >= today ? null : next });
                }}
                className="min-h-11 px-3 rounded-lg border border-border text-sm text-text-secondary hover:border-accent/50 disabled:opacity-40"
                aria-label={totalsT.nextDay}
              >
                {totalsT.nextDay}
              </button>
            </div>
            {summary.isPending ? (
              <PageSkeleton variant="list" rows={3} />
            ) : summary.isError || !summary.data ? (
              <div className="p-6 text-center space-y-3">
                <p className="text-sm text-text-secondary">{inbox.loadFailed}</p>
                <Button variant="secondary" onClick={() => void summary.refetch()}>
                  {web.inbox.retry}
                </Button>
              </div>
            ) : (
              <DailyTotalsTable summary={summary.data} showCredits={ingestOn} />
            )}
          </div>
        ) : params.tab === "credits" ? null : (
          <div className="bg-white rounded-2xl border border-border overflow-hidden">
            {list.isPending ? (
              <PageSkeleton variant="list" />
            ) : list.isError ? (
              <div className="p-6 text-center space-y-3">
                <p className="text-sm text-text-secondary">{online ? inbox.loadFailed : inbox.offline.title}</p>
                <Button variant="secondary" onClick={() => void list.refetch()}>
                  {web.inbox.retry}
                </Button>
              </div>
            ) : rows.length === 0 ? (
              <div data-testid="collections-empty" className="px-4 py-10 text-center space-y-1">
                <p className="text-sm font-semibold text-text-primary">{emptyCopy?.title}</p>
                {emptyCopy?.hint && <p className="text-xs text-text-secondary">{emptyCopy.hint}</p>}
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {rows.map((c) => (
                  <CollectionRow
                    key={c.id}
                    c={c}
                    showBranch={params.allBranches}
                    branchName={branchName(c.branchId)}
                    onOpen={(id) => setParams({ id })}
                  />
                ))}
              </ul>
            )}
            {list.hasNextPage && (
              <div className="p-3 border-t border-border flex justify-center">
                <Button
                  variant="secondary"
                  data-testid="collections-load-more"
                  loading={list.isFetchingNextPage}
                  onClick={() => void list.fetchNextPage()}
                >
                  {web.inbox.loadMore}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <CollectionDetailModal
        key={params.id ?? "none"}
        id={params.id}
        access={access}
        onClose={() => setParams({ id: null })}
        onDone={(done) => {
          const doneT = dict.app.collections.detail.done as Record<string, string>;
          setToast(doneT[done] ?? done);
          if (done === "confirmed" || done === "rejected") setParams({ id: null });
        }}
      />
      {toast && <Toast type="success" message={toast} onClose={() => setToast(null)} />}
    </AppShell>
  );
}
