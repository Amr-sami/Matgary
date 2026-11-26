"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Plus, Pencil, Trash2, Search, Truck, Phone, Wallet } from "@/lib/icons";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Toast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SupplierFormModal } from "@/components/suppliers/SupplierFormModal";
import { useSuppliers } from "@/hooks/useSuppliers";
import { can } from "@/lib/permissions";
import type { SupplierDescriptor } from "@/lib/types";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";

type ToastState = { type: "success" | "error"; message: string } | null;

export default function SuppliersPage() {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.suppliers;
  const { data: suppliers, loading, refresh } = useSuppliers();
  const { data: session } = useSession();
  const principal = session?.user
    ? { role: session.user.role, permissions: session.user.permissions }
    : null;
  const canManage = can(principal, "manage_suppliers");

  const [query, setQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SupplierDescriptor | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SupplierDescriptor | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter((s) =>
      `${s.name} ${s.phone || ""} ${s.email || ""}`.toLowerCase().includes(q),
    );
  }, [suppliers, query]);

  const totalOwed = useMemo(
    () => suppliers.reduce((sum, s) => sum + (s.balance > 0 ? s.balance : 0), 0),
    [suppliers],
  );

  const openAdd = () => {
    setEditTarget(null);
    setModalOpen(true);
  };

  const openEdit = (s: SupplierDescriptor) => {
    setEditTarget(s);
    setModalOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/suppliers/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setToast({ type: "error", message: json.error || t.list.toast.deleteFailed });
        return;
      }
      setToast({ type: "success", message: t.list.toast.deleted });
      setDeleteTarget(null);
      await refresh();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AppShell title={t.title}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">{t.list.heading}</h1>
            <p className="text-sm text-text-secondary mt-1">
              {t.list.count.replace("{n}", String(suppliers.length))}
              {totalOwed > 0 && (
                <>
                  {" · "}
                  <span className="text-danger font-medium">
                    {t.list.outstanding.replace("{amount}", formatCurrency(totalOwed, locale))}
                  </span>
                </>
              )}
            </p>
          </div>
          {canManage && (
            <Button onClick={openAdd}>
              <Plus className="w-4 h-4 me-1" />
              {t.list.add}
            </Button>
          )}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 end-3 text-text-secondary" />
          <input
            type="search"
            placeholder={t.list.searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full ps-10 pe-3 py-2.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>

        {/* List */}
        {loading ? (
          <p className="text-sm text-text-secondary">{t.list.loading}</p>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-2xl border border-border py-12 text-center">
            <Truck className="w-9 h-9 mx-auto mb-4 text-text-secondary" />
            <p className="text-text-secondary">
              {query ? t.list.noResults : t.list.empty}
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-border divide-y divide-border">
            {filtered.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-3 p-4 hover:bg-bg-main transition-colors"
              >
                <Truck className="w-6 h-6 text-accent shrink-0" />
                <div className="flex-1 min-w-0">
                  <Link
                    href={`/suppliers/${s.id}`}
                    className="font-medium text-text-primary hover:text-accent block truncate"
                    dir="auto"
                  >
                    {s.name}
                  </Link>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary mt-0.5">
                    {s.phone && (
                      <span className="inline-flex items-center gap-1" dir="ltr">
                        <Phone className="w-3 h-3" />
                        {s.phone}
                      </span>
                    )}
                    {s.balance > 0 && (
                      <span className="inline-flex items-center gap-1 text-danger font-medium">
                        <Wallet className="w-3 h-3" />
                        {t.list.owedLabel.replace("{amount}", formatCurrency(s.balance, locale))}
                      </span>
                    )}
                  </div>
                </div>
                {canManage && (
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => openEdit(s)}
                      className="p-2 rounded-md text-text-secondary hover:bg-accent-light hover:text-accent"
                      title={t.list.editTitle}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(s)}
                      className="p-2 rounded-md text-text-secondary hover:bg-danger-light hover:text-danger"
                      title={t.list.deleteTitle}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <SupplierFormModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        supplier={editTarget}
        onSaved={async () => {
          setToast({
            type: "success",
            message: editTarget ? t.list.toast.edited : t.list.toast.added,
          });
          await refresh();
        }}
        onError={(message) => setToast({ type: "error", message })}
      />

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => !deleting && setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title={t.list.deleteDialog.title}
        message={
          deleteTarget
            ? t.list.deleteDialog.message.replace("{name}", deleteTarget.name)
            : ""
        }
        confirmText={t.list.deleteDialog.confirm}
        variant="danger"
        loading={deleting}
      />

      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
    </AppShell>
  );
}
