"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  ChevronRight,
  Pencil,
  Phone,
  AtSign,
  MapPin,
  Receipt,
  Wallet,
  Truck,
} from "@/lib/icons";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Toast } from "@/components/ui/Toast";
import { SupplierFormModal } from "@/components/suppliers/SupplierFormModal";
import { usePurchaseOrders } from "@/hooks/usePurchaseOrders";
import { useExpenses } from "@/hooks/useExpenses";
import { can } from "@/lib/permissions";
import type { SupplierDescriptor } from "@/lib/types";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency, formatDate } from "@/lib/i18n/format";

const STATUS_STYLES: Record<"draft" | "received" | "cancelled", string> = {
  draft: "bg-orange-100 text-orange-700",
  received: "bg-success-light text-success",
  cancelled: "bg-gray-100 text-gray-500",
};

export default function SupplierDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.suppliers.detail;
  const statusLabels = dict.app.purchasesStatus;
  const { data: session } = useSession();
  const principal = session?.user
    ? { role: session.user.role, permissions: session.user.permissions }
    : null;
  const canManage = can(principal, "manage_suppliers");

  const [supplier, setSupplier] = useState<SupplierDescriptor | null>(null);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const { data: orders } = usePurchaseOrders({ supplierId: id });
  const { expenses } = useExpenses();

  const supplierExpenses = useMemo(
    () =>
      expenses
        .filter((e) => e.supplierId === id)
        .sort((a, b) => b.date.getTime() - a.date.getTime()),
    [expenses, id],
  );

  const fetchSupplier = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/suppliers/${id}`, { cache: "no-store" });
      if (!res.ok) {
        setSupplier(null);
        return;
      }
      const json = await res.json();
      setSupplier({
        ...json.data,
        createdAt: new Date(json.data.createdAt),
        updatedAt: new Date(json.data.updatedAt),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSupplier();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const totalReceived = useMemo(
    () => orders.filter((o) => o.status === "received").reduce((s, o) => s + o.total, 0),
    [orders],
  );
  const totalPaid = useMemo(
    () => supplierExpenses.reduce((s, e) => s + e.amount, 0),
    [supplierExpenses],
  );

  if (loading) {
    return (
      <AppShell title={t.title}>
        <p className="text-sm text-text-secondary">{t.loading}</p>
      </AppShell>
    );
  }

  if (!supplier) {
    return (
      <AppShell title={t.title}>
        <div className="bg-white rounded-2xl border border-border p-8 text-center">
          <p className="text-text-secondary mb-4">{t.notFound}</p>
          <Link href="/suppliers" className="text-accent hover:underline">
            {t.backToList}
          </Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title={supplier.name}>
      <div className="space-y-6">
        {/* Breadcrumb */}
        <nav className="text-sm text-text-secondary flex items-center gap-1">
          <Link href="/suppliers" className="hover:text-accent">{dict.app.suppliers.list.heading}</Link>
          <ChevronRight className="w-4 h-4" />
          <span className="text-text-primary" dir="auto">{supplier.name}</span>
        </nav>

        {/* Header card */}
        <div className="bg-white rounded-2xl border border-border p-5 flex flex-col md:flex-row gap-4 md:items-center">
          <div className="w-14 h-14 rounded-full bg-accent-light text-accent flex items-center justify-center shrink-0">
            <Truck className="w-7 h-7" />
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-text-primary" dir="auto">{supplier.name}</h1>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-secondary mt-1">
              {supplier.phone && (
                <span className="inline-flex items-center gap-1" dir="ltr">
                  <Phone className="w-4 h-4" />
                  {supplier.phone}
                </span>
              )}
              {supplier.email && (
                <span className="inline-flex items-center gap-1" dir="ltr">
                  <AtSign className="w-4 h-4" />
                  {supplier.email}
                </span>
              )}
              {supplier.address && (
                <span className="inline-flex items-center gap-1" dir="auto">
                  <MapPin className="w-4 h-4" />
                  {supplier.address}
                </span>
              )}
            </div>
          </div>
          {canManage && (
            <Button variant="secondary" onClick={() => setEditOpen(true)}>
              <Pencil className="w-4 h-4 me-1" />
              {t.edit}
            </Button>
          )}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-white rounded-2xl border border-border p-4">
            <p className="text-xs text-text-secondary">{t.stats.balance}</p>
            <p
              className={`text-2xl font-bold mt-1 ${
                supplier.balance > 0 ? "text-danger" : "text-text-primary"
              }`}
            >
              {formatCurrency(supplier.balance, locale)}
            </p>
          </div>
          <div className="bg-white rounded-2xl border border-border p-4">
            <p className="text-xs text-text-secondary">{t.stats.totalPurchases}</p>
            <p className="text-2xl font-bold mt-1 text-text-primary">
              {formatCurrency(totalReceived, locale)}
            </p>
          </div>
          <div className="bg-white rounded-2xl border border-border p-4">
            <p className="text-xs text-text-secondary">{t.stats.totalPayments}</p>
            <p className="text-2xl font-bold mt-1 text-success">
              {formatCurrency(totalPaid, locale)}
            </p>
          </div>
        </div>

        {/* Notes */}
        {supplier.notes && (
          <div className="bg-white rounded-2xl border border-border p-4">
            <p className="text-xs text-text-secondary mb-1">{t.notes}</p>
            <p className="text-sm whitespace-pre-wrap" dir="auto">{supplier.notes}</p>
          </div>
        )}

        {/* Purchase orders */}
        <section>
          <h2 className="text-lg font-bold text-text-primary mb-3 flex items-center gap-2">
            <Receipt className="w-5 h-5" />
            {t.purchaseOrders}
          </h2>
          {orders.length === 0 ? (
            <p className="text-sm text-text-secondary">{t.purchaseOrdersEmpty}</p>
          ) : (
            <div className="bg-white rounded-2xl border border-border divide-y divide-border">
              {orders.slice(0, 10).map((o) => (
                <div key={o.id} className="p-4 flex justify-between items-center">
                  <div>
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-medium">
                        {t.itemCount.replace("{n}", String(o.itemCount))}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          STATUS_STYLES[o.status]
                        }`}
                      >
                        {statusLabels[o.status]}
                      </span>
                    </div>
                    <p className="text-xs text-text-secondary">
                      {formatDate(o.orderDate, locale)}
                    </p>
                  </div>
                  <p className="font-bold">{formatCurrency(o.total, locale)}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Payments (linked expenses) */}
        <section>
          <h2 className="text-lg font-bold text-text-primary mb-3 flex items-center gap-2">
            <Wallet className="w-5 h-5" />
            {t.payments}
          </h2>
          {supplierExpenses.length === 0 ? (
            <p className="text-sm text-text-secondary">
              {t.paymentsEmpty}
            </p>
          ) : (
            <div className="bg-white rounded-2xl border border-border divide-y divide-border">
              {supplierExpenses.slice(0, 10).map((e) => (
                <div key={e.id} className="p-4 flex justify-between items-center">
                  <div>
                    <p className="font-medium" dir="auto">{e.title}</p>
                    <p className="text-xs text-text-secondary">
                      {formatDate(e.date, locale)}
                    </p>
                  </div>
                  <p className="font-bold text-success">{formatCurrency(e.amount, locale)}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <SupplierFormModal
        isOpen={editOpen}
        onClose={() => setEditOpen(false)}
        supplier={supplier}
        onSaved={async () => {
          setToast({ type: "success", message: t.toast.edited });
          await fetchSupplier();
        }}
        onError={(message) => setToast({ type: "error", message })}
      />

      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
    </AppShell>
  );
}
