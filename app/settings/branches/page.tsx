"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Toast } from "@/components/ui/Toast";
import {
  Plus,
  Pencil,
  Trash2,
  Store,
  Eye,
  EyeOff,
} from "@/lib/icons";
import { useBranches, type BranchSummary } from "@/hooks/useBranches";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface DraftBranch {
  id: string | null;
  name: string;
  address: string;
  phone: string;
}

const EMPTY_DRAFT: DraftBranch = {
  id: null,
  name: "",
  address: "",
  phone: "",
};

export default function BranchesSettingsPage() {
  const dict = useDictionary();
  const t = dict.app.branchesPage;
  const { data: session, status } = useSession();
  const router = useRouter();
  const isOwner = session?.user?.role === "owner";

  const { branches, current, loading, refresh, switchTo } = useBranches();
  const [draft, setDraft] = useState<DraftBranch | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{
    msg: string;
    tone: "success" | "error";
  } | null>(null);

  useEffect(() => {
    if (status === "loading") return;
    if (!isOwner) router.replace("/settings");
  }, [status, isOwner, router]);

  if (status === "loading" || !isOwner) {
    return (
      <AppShell title={t.shellTitle}>
        <p className="text-sm text-text-secondary">{t.loading}</p>
      </AppShell>
    );
  }

  const startEdit = (b: BranchSummary) =>
    setDraft({
      id: b.id,
      name: b.name,
      address: b.address ?? "",
      phone: b.phone ?? "",
    });

  const startCreate = () => setDraft({ ...EMPTY_DRAFT });
  const cancelDraft = () => setDraft(null);

  const submit = async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      setToast({ msg: t.toast.nameRequired, tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const isCreate = draft.id === null;
      const url = isCreate ? "/api/branches" : `/api/branches/${draft.id}`;
      const method = isCreate ? "POST" : "PATCH";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name.trim(),
          address: draft.address.trim() || null,
          phone: draft.phone.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? t.toast.saveFailed);
      }
      setToast({
        msg: isCreate ? t.toast.created : t.toast.edited,
        tone: "success",
      });
      setDraft(null);
      await refresh();
    } catch (err) {
      setToast({
        msg: err instanceof Error ? err.message : t.toast.genericError,
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (b: BranchSummary) => {
    if (b.isPrimary && b.isActive) {
      setToast({ msg: t.toast.primarySuspend, tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/branches/${b.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !b.isActive }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? t.toast.updateFailed);
      }
      setToast({
        msg: b.isActive ? t.toast.suspended : t.toast.activated,
        tone: "success",
      });
      await refresh();
    } catch (err) {
      setToast({
        msg: err instanceof Error ? err.message : t.toast.genericError,
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (b: BranchSummary) => {
    if (b.isPrimary) {
      setToast({ msg: t.toast.primaryDelete, tone: "error" });
      return;
    }
    if (!window.confirm(t.confirmDelete.replace("{name}", b.name))) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/branches/${b.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const counts = body.counts as
          | Record<string, number>
          | undefined;
        const hint = counts
          ? Object.entries(counts)
              .filter(([, n]) => n > 0)
              .map(([k, n]) => `${k}: ${n}`)
              .join(" • ")
          : "";
        throw new Error(`${body.error ?? t.toast.deleteFailed}${hint ? ` (${hint})` : ""}`);
      }
      setToast({ msg: t.toast.deleted, tone: "success" });
      await refresh();
    } catch (err) {
      setToast({
        msg: err instanceof Error ? err.message : t.toast.genericError,
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell title={t.title}>
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">{t.heading}</h1>
            <p className="text-sm text-text-secondary mt-1">
              {t.subhead}
            </p>
          </div>
          {!draft && (
            <Button onClick={startCreate} disabled={busy} className="shrink-0">
              <Plus className="w-4 h-4" />
              {t.add}
            </Button>
          )}
        </header>

        {/* Editor */}
        {draft && (
          <div className="bg-bg-card border border-border rounded-2xl p-5 space-y-4">
            <h2 className="text-base font-semibold text-text-primary">
              {draft.id ? t.editTitle : t.newTitle}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Input
                label={t.nameLabel}
                value={draft.name}
                onChange={(e) =>
                  setDraft({ ...draft, name: e.target.value })
                }
                placeholder={t.namePlaceholder}
                disabled={busy}
              />
              <Input
                label={t.phoneLabel}
                value={draft.phone}
                onChange={(e) =>
                  setDraft({ ...draft, phone: e.target.value })
                }
                placeholder="01XXXXXXXXX"
                disabled={busy}
              />
              <div className="md:col-span-2">
                <Input
                  label={t.addressLabel}
                  value={draft.address}
                  onChange={(e) =>
                    setDraft({ ...draft, address: e.target.value })
                  }
                  placeholder={t.addressPlaceholder}
                  disabled={busy}
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={cancelDraft}
                disabled={busy}
                className="text-sm text-text-secondary hover:text-text-primary px-3 py-2"
              >
                {t.cancel}
              </button>
              <Button onClick={submit} disabled={busy} loading={busy}>
                {draft.id ? t.saveChanges : t.create}
              </Button>
            </div>
          </div>
        )}

        {/* List */}
        <div className="bg-bg-card border border-border rounded-2xl overflow-hidden">
          {loading ? (
            <p className="text-sm text-text-secondary text-center py-10">
              {t.loading}
            </p>
          ) : branches.length === 0 ? (
            <p className="text-sm text-text-secondary text-center py-10">
              {t.empty}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {branches.map((b) => {
                const isCurrent = b.id === current?.id;
                return (
                  <li
                    key={b.id}
                    className="flex items-start gap-3 px-5 py-4"
                  >
                    <div
                      className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${
                        b.isActive
                          ? "bg-accent-light text-accent"
                          : "bg-gray-100 text-text-secondary"
                      }`}
                    >
                      <Store className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-text-primary truncate" dir="auto">
                          {b.name}
                        </p>
                        {b.isPrimary && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent-light text-accent">
                            {t.labels.primary}
                          </span>
                        )}
                        {isCurrent && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-success-light text-success">
                            {t.labels.current}
                          </span>
                        )}
                        {!b.isActive && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-text-secondary">
                            {t.labels.suspended}
                          </span>
                        )}
                      </div>
                      {b.address && (
                        <p className="text-xs text-text-secondary mt-0.5 truncate" dir="auto">
                          {b.address}
                        </p>
                      )}
                      {b.phone && (
                        <p className="text-xs text-text-secondary mt-0.5" dir="ltr">
                          {b.phone}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {!isCurrent && b.isActive && (
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await switchTo(b.id);
                            } catch (err) {
                              setToast({
                                msg:
                                  err instanceof Error
                                    ? err.message
                                    : t.toast.switchFailed,
                                tone: "error",
                              });
                            }
                          }}
                          disabled={busy}
                          className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:bg-accent-hover transition-colors"
                        >
                          {t.actions.open}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => startEdit(b)}
                        disabled={busy}
                        title={t.actions.edit}
                        className="p-2 rounded-md text-text-secondary hover:bg-bg-main hover:text-accent"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleActive(b)}
                        disabled={busy || b.isPrimary}
                        title={b.isActive ? t.actions.suspend : t.actions.activate}
                        className={`p-2 rounded-md transition-colors disabled:opacity-30 ${
                          b.isActive
                            ? "text-text-secondary hover:bg-bg-main hover:text-orange-600"
                            : "text-success hover:bg-success-light"
                        }`}
                      >
                        {b.isActive ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(b)}
                        disabled={busy || b.isPrimary}
                        title={t.actions.delete}
                        className="p-2 rounded-md text-text-secondary hover:bg-danger-light hover:text-danger disabled:opacity-30"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {toast && (
        <Toast
          message={toast.msg}
          type={toast.tone}
          onClose={() => setToast(null)}
        />
      )}
    </AppShell>
  );
}
