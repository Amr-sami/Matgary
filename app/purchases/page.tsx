"use client";

import { useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { Plus, Receipt, CheckCircle, XCircle, Trash2 } from "@/lib/icons";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Toast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PurchaseOrderBuilder } from "@/components/purchases/PurchaseOrderBuilder";
import {
  usePurchaseOrders,
  type PurchaseOrderStatus,
} from "@/hooks/usePurchaseOrders";
import { can } from "@/lib/permissions";
import { formatPrice } from "@/lib/utils";

type ToastState = { type: "success" | "error"; message: string } | null;
type PendingAction =
  | { kind: "receive"; id: string }
  | { kind: "cancel"; id: string }
  | { kind: "delete"; id: string }
  | null;

const ACTION_COPY: Record<
  Exclude<PendingAction, null>["kind"],
  { title: string; message: string; confirmText: string; variant: "danger" | "primary" }
> = {
  receive: {
    title: "استلام أمر الشراء",
    message:
      "سيتم إضافة الكميات إلى المخزن وتسجيل المبلغ كمستحق على المورد. هل تريد المتابعة؟",
    confirmText: "استلام",
    variant: "primary",
  },
  cancel: {
    title: "إلغاء أمر الشراء",
    message: "سيتم إلغاء هذا الأمر. لن يتأثر المخزن. هل أنت متأكد؟",
    confirmText: "إلغاء الأمر",
    variant: "danger",
  },
  delete: {
    title: "حذف أمر الشراء",
    message: "سيتم حذف هذا الأمر نهائياً ولا يمكن التراجع عنه.",
    confirmText: "حذف",
    variant: "danger",
  },
};

const STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  draft: "مسودة",
  received: "تم الاستلام",
  cancelled: "ملغي",
};

const STATUS_STYLES: Record<PurchaseOrderStatus, string> = {
  draft: "bg-orange-100 text-orange-700",
  received: "bg-success-light text-success",
  cancelled: "bg-gray-100 text-gray-500",
};

const FILTER_TABS: { value: PurchaseOrderStatus | "all"; label: string }[] = [
  { value: "all", label: "الكل" },
  { value: "draft", label: "مسودات" },
  { value: "received", label: "مستلمة" },
  { value: "cancelled", label: "ملغية" },
];

export default function PurchasesPage() {
  const { data: session } = useSession();
  const principal = session?.user
    ? { role: session.user.role, permissions: session.user.permissions }
    : null;
  const canManage = can(principal, "manage_purchases");

  const [filter, setFilter] = useState<PurchaseOrderStatus | "all">("all");
  const { data: orders, loading, refresh } = usePurchaseOrders(
    filter === "all" ? undefined : { status: filter },
  );

  const [builderOpen, setBuilderOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  const draftCount = useMemo(
    () => orders.filter((o) => o.status === "draft").length,
    [orders],
  );
  const monthSpend = useMemo(() => {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    return orders
      .filter((o) => o.status === "received" && o.receivedDate && o.receivedDate >= since)
      .reduce((sum, o) => sum + o.total, 0);
  }, [orders]);

  const runPending = async () => {
    if (!pending) return;
    setSubmitting(true);
    try {
      let res: Response;
      let successMsg = "";
      let errorMsg = "";
      if (pending.kind === "receive") {
        res = await fetch(`/api/purchase-orders/${pending.id}/receive`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updateCost: true }),
        });
        successMsg = "تم الاستلام وتحديث المخزن";
        errorMsg = "تعذر الاستلام";
      } else if (pending.kind === "cancel") {
        res = await fetch(`/api/purchase-orders/${pending.id}/cancel`, { method: "POST" });
        successMsg = "تم الإلغاء";
        errorMsg = "تعذر الإلغاء";
      } else {
        res = await fetch(`/api/purchase-orders/${pending.id}`, { method: "DELETE" });
        successMsg = "تم الحذف";
        errorMsg = "تعذر الحذف";
      }
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setToast({ type: "error", message: json.error || errorMsg });
        return;
      }
      setToast({ type: "success", message: successMsg });
      setPending(null);
      await refresh();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppShell title="المشتريات">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">المشتريات</h1>
            <p className="text-sm text-text-secondary mt-1">
              {draftCount > 0 && (
                <>
                  {draftCount} مسودة بانتظار الاستلام
                  {monthSpend > 0 && " · "}
                </>
              )}
              {monthSpend > 0 && (
                <>إجمالي 30 يوم: {formatPrice(monthSpend)}</>
              )}
            </p>
          </div>
          {canManage && (
            <Button onClick={() => setBuilderOpen(true)}>
              <Plus className="w-4 h-4 me-1" />
              أمر شراء جديد
            </Button>
          )}
        </div>

        {/* Filter tabs */}
        <div className="flex flex-wrap gap-2">
          {FILTER_TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setFilter(t.value)}
              className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                filter === t.value
                  ? "bg-accent text-white border-accent"
                  : "bg-white border-border text-text-secondary hover:border-accent"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* List */}
        {loading ? (
          <p className="text-sm text-text-secondary">جاري التحميل…</p>
        ) : orders.length === 0 ? (
          <div className="bg-white rounded-2xl border border-border py-12 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gray-100 flex items-center justify-center">
              <Receipt className="w-8 h-8 text-text-secondary" />
            </div>
            <p className="text-text-secondary">لا توجد أوامر شراء بعد.</p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-border divide-y divide-border">
            {orders.map((o) => (
              <div key={o.id} className="p-4 flex flex-col sm:flex-row gap-3 sm:items-center">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-text-primary truncate">
                      {o.supplierName}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${
                        STATUS_STYLES[o.status]
                      }`}
                    >
                      {STATUS_LABELS[o.status]}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary">
                    <span>{o.itemCount} صنف</span>
                    <span>{formatPrice(o.total)}</span>
                    <span>
                      {o.status === "received" && o.receivedDate
                        ? `استُلم ${o.receivedDate.toLocaleDateString("ar-EG")}`
                        : `طُلب ${o.orderDate.toLocaleDateString("ar-EG")}`}
                    </span>
                  </div>
                  {o.notes && (
                    <p className="text-xs text-text-secondary mt-1 truncate">{o.notes}</p>
                  )}
                </div>

                {canManage && o.status === "draft" && (
                  <div className="flex gap-2 shrink-0">
                    <Button size="sm" onClick={() => setPending({ kind: "receive", id: o.id })}>
                      <CheckCircle className="w-4 h-4 me-1" />
                      استلام
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPending({ kind: "cancel", id: o.id })}
                    >
                      <XCircle className="w-4 h-4 me-1" />
                      إلغاء
                    </Button>
                    <button
                      type="button"
                      onClick={() => setPending({ kind: "delete", id: o.id })}
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

      <PurchaseOrderBuilder
        isOpen={builderOpen}
        onClose={() => setBuilderOpen(false)}
        onSaved={async () => {
          setToast({ type: "success", message: "تم إنشاء أمر الشراء" });
          await refresh();
        }}
        onError={(message) => setToast({ type: "error", message })}
      />

      <ConfirmDialog
        isOpen={!!pending}
        onClose={() => !submitting && setPending(null)}
        onConfirm={runPending}
        title={pending ? ACTION_COPY[pending.kind].title : ""}
        message={pending ? ACTION_COPY[pending.kind].message : ""}
        confirmText={pending ? ACTION_COPY[pending.kind].confirmText : "تأكيد"}
        variant={pending ? ACTION_COPY[pending.kind].variant : "danger"}
        loading={submitting}
      />

      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
    </AppShell>
  );
}
