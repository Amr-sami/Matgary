"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { Button } from "@/components/ui/Button";
import { Toast } from "@/components/ui/Toast";
import { ChevronRight } from "@/lib/icons";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { useBranches } from "@/hooks/useBranches";
import { useActiveBranchId, useCollectionSettings, useCollectionsAccess } from "@/hooks/useCollections";
import { useCollectionAccounts } from "@/hooks/useCollectionAccounts";
import { CollectionSwitchesCard } from "@/components/collections/CollectionSwitchesCard";
import { AccountsCard } from "@/components/collections/AccountsCard";
import { AccountFormModal } from "@/components/collections/AccountFormModal";
import { DevicesCard } from "@/components/collections/DevicesCard";
import type { CollectionAccount } from "@/lib/api/collections";
import type { CollectionRail } from "@matgary/domain/collections/types";
import { cn } from "@/lib/utils";

// Collections settings on the web (doc 15 spec 12 §4.8): receiving accounts
// and the branch switches for `manage_collection_accounts`. Reachable while
// COLLECTIONS_ENABLED admits the shop even when this branch's switch is off
// (`features.collectionsAvailable`), so the owner can turn it on. Automation
// setup and device creation stay phone-only (Q8). `?branch=` (owner, more than
// one branch) needs useSearchParams → the Suspense boundary below.

export default function CollectionsSettingsPage() {
  const dict = useDictionary();
  return (
    <Suspense
      fallback={
        <AppShell title={dict.app.collectionsSettings.title}>
          <PageSkeleton variant="list" />
        </AppShell>
      }
    >
      <CollectionsSettingsInner />
    </Suspense>
  );
}

function CollectionsSettingsInner() {
  const dict = useDictionary();
  const t = dict.app.collectionsSettings;
  const router = useRouter();
  const sp = useSearchParams();
  const access = useCollectionsAccess();
  const { canManage, available, isOwner, features, loading } = access;
  const { branches } = useBranches();
  // The cached active branch, else the one the config answered for.
  const cachedBranchId = useActiveBranchId();
  const activeBranchId = cachedBranchId ?? access.config?.branchId ?? null;
  const multiBranch = isOwner && branches.length > 1;
  const requested = sp.get("branch");
  const branchId =
    multiBranch && requested && branches.some((b) => b.id === requested) ? requested : activeBranchId;

  const enabled = canManage && available;
  const settings = useCollectionSettings(branchId, enabled);
  const accountsQ = useCollectionAccounts({ scope: isOwner ? "all" : "branch", enabled });
  const accounts = useMemo(
    () =>
      accountsQ.accounts.filter(
        (a) => a.archivedAt == null && (a.branchId == null || a.branchId === branchId),
      ),
    [accountsQ.accounts, branchId],
  );

  const [form, setForm] = useState<{ rail: CollectionRail; account: CollectionAccount | null } | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const back = (
    <Link
      href="/settings"
      className="inline-flex items-center gap-1 text-sm text-text-secondary hover:text-accent transition-colors"
    >
      <ChevronRight className="w-4 h-4 rtl:rotate-0 ltr:rotate-180" />
      {dict.app.settingsPage.title}
    </Link>
  );

  let body: React.ReactNode;
  if (loading) {
    body = <PageSkeleton variant="list" />;
  } else if (!canManage) {
    body = (
      <p data-testid="collections-settings-no-permission" className="bg-white rounded-2xl border border-border p-6 text-sm text-text-secondary">
        {t.noPermission}
      </p>
    );
  } else if (!available) {
    body = (
      <p data-testid="collections-settings-unavailable" className="bg-white rounded-2xl border border-border p-6 text-sm text-text-secondary">
        {t.unavailable}
      </p>
    );
  } else if (settings.isPending || (accountsQ.loading && accountsQ.accounts.length === 0)) {
    body = <PageSkeleton variant="list" />;
  } else if (settings.isError || !settings.data) {
    body = (
      <div className="bg-white rounded-2xl border border-border p-6 text-center space-y-3">
        <p className="text-sm text-text-secondary">{t.saveFailed}</p>
        <Button variant="secondary" onClick={() => void settings.refetch()}>
          {dict.app.collections.web.inbox.retry}
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="space-y-4">
        {multiBranch && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={dict.app.collections.web.settings.branch}>
            <span className="text-xs text-text-secondary">{dict.app.collections.web.settings.branch}</span>
            {branches.map((b) => (
              <button
                key={b.id}
                type="button"
                data-testid={`collections-settings-branch-${b.id}`}
                aria-pressed={b.id === branchId}
                onClick={() => router.replace(`/settings/collections?branch=${encodeURIComponent(b.id)}`, { scroll: false })}
                className={cn(
                  "min-h-11 px-3 rounded-lg border text-sm",
                  b.id === branchId ? "bg-accent text-white border-accent" : "bg-white text-text-secondary border-border",
                )}
              >
                {b.name}
              </button>
            ))}
          </div>
        )}
        <CollectionSwitchesCard
          branchId={branchId}
          settings={settings.data}
          ingestOn={features.collectionsIngest}
          onToast={(type, message) => setToast({ type, message })}
        />
        <AccountsCard
          accounts={accounts}
          enabled={settings.data.collectionsEnabled}
          ingestOn={features.collectionsIngest}
          onAdd={(rail) => setForm({ rail, account: null })}
          onOpen={(account) => setForm({ rail: account.rail, account })}
        />
        {!multiBranch && branches.length > 1 && (
          <p className="text-xs text-text-secondary">{t.accounts.otherBranchesNote}</p>
        )}
        {features.collectionsIngest && (
          <>
            <section
              data-testid="collections-settings-automation-web"
              className="bg-white rounded-2xl border border-border px-4 py-3 space-y-1"
            >
              <h2 className="text-sm font-semibold text-text-primary">{dict.app.collections.web.settings.automationTitle}</h2>
              <p className="text-xs text-text-secondary">{dict.app.collections.web.settings.automationOnPhone}</p>
            </section>
            <DevicesCard accounts={accountsQ.accounts} onToast={(type, message) => setToast({ type, message })} />
          </>
        )}
      </div>
    );
  }

  const branchOptions = isOwner
    ? branches.map((b) => ({ id: b.id, name: b.name }))
    : branches.filter((b) => b.id === activeBranchId).map((b) => ({ id: b.id, name: b.name }));

  return (
    <AppShell title={t.title}>
      <div className="max-w-3xl mx-auto space-y-4">
        {back}
        {body}
      </div>
      {form && (
        <AccountFormModal
          key={form.account?.id ?? `new-${form.rail}`}
          open
          rail={form.rail}
          account={form.account}
          branches={branchOptions}
          defaultBranchId={branchId}
          isOwner={isOwner}
          ingestOn={features.collectionsIngest}
          branchAutoConfirmOn={!!settings.data?.collectionsAutoConfirmEnabled}
          onClose={() => setForm(null)}
          onSaved={(message) => {
            setForm(null);
            setToast({ type: "success", message });
          }}
        />
      )}
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
    </AppShell>
  );
}
