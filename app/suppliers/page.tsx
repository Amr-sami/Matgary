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
import { formatPrice } from "@/lib/utils";
import type { SupplierDescriptor } from "@/lib/types";

type ToastState = { type: "success" | "error"; message: string } | null;

export default function SuppliersPage() {
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
        setToast({ type: "error", message: json.error || "تعذر الحذف" });
        return;
      }
      setToast({ type: "success", message: "تم حذف المورد" });
      setDeleteTarget(null);
      await refresh();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AppShell title="الموردين">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">الموردين</h1>
            <p className="text-sm text-text-secondary mt-1">
              {suppliers.length} مورد
              {totalOwed > 0 && (
                <>
                  {" · "}
                  <span className="text-danger font-medium">
                    إجمالي مستحق: {formatPrice(totalOwed)}
                  </span>
                </>
              )}
            </p>
          </div>
          {canManage && (
            <Button onClick={openAdd}>
              <Plus className="w-4 h-4 me-1" />
              إضافة مورد
            </Button>
          )}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 end-3 text-text-secondary" />
          <input
            type="search"
            dir="rtl"
            placeholder="بحث بالاسم أو الهاتف أو البريد"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full ps-10 pe-3 py-2.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>

        {/* List */}
        {loading ? (
          <p className="text-sm text-text-secondary">جاري التحميل…</p>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-2xl border border-border py-12 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gray-100 flex items-center justify-center">
              <Truck className="w-8 h-8 text-text-secondary" />
            </div>
            <p className="text-text-secondary">
              {query ? "لا نتائج مطابقة." : "لم تتم إضافة أي مورد بعد."}
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-border divide-y divide-border">
            {filtered.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-3 p-4 hover:bg-bg-main transition-colors"
              >
                <div className="w-10 h-10 rounded-full bg-accent-light text-accent flex items-center justify-center shrink-0">
                  <Truck className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <Link
                    href={`/suppliers/${s.id}`}
                    className="font-medium text-text-primary hover:text-accent block truncate"
                  >
                    {s.name}
                  </Link>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary mt-0.5">
                    {s.phone && (
                      <span className="inline-flex items-center gap-1">
                        <Phone className="w-3 h-3" />
                        {s.phone}
                      </span>
                    )}
                    {s.balance > 0 && (
                      <span className="inline-flex items-center gap-1 text-danger font-medium">
                        <Wallet className="w-3 h-3" />
                        مستحق: {formatPrice(s.balance)}
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
                      title="تعديل"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(s)}
                      className="p-2 rounded-md text-text-secondary hover:bg-danger-light hover:text-danger"
                      title="حذف"
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
            message: editTarget ? "تم حفظ التعديلات" : "تم إضافة المورد",
          });
          await refresh();
        }}
        onError={(message) => setToast({ type: "error", message })}
      />

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => !deleting && setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="حذف المورد"
        message={
          deleteTarget
            ? `هل تريد حذف المورد "${deleteTarget.name}"؟ هذا الإجراء لا يمكن التراجع عنه.`
            : ""
        }
        confirmText="حذف"
        variant="danger"
        loading={deleting}
      />

      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
    </AppShell>
  );
}
