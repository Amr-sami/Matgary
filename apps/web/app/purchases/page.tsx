"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Plus,
  Receipt,
  CheckCircle,
  XCircle,
  Trash2,
  ChevronDown,
  ChevronUp,
  Wallet,
} from "@/lib/icons";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Toast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PurchaseOrderBuilder } from "@/components/purchases/PurchaseOrderBuilder";
import { PurchasesKpiCards } from "@/components/purchases/PurchasesKpiCards";
import {
  PurchasesFilters,
  type PaymentStatusKey,
} from "@/components/purchases/PurchasesFilters";
import { PaymentModal } from "@/components/purchases/PaymentModal";
import {
  usePurchaseOrders,
  type PurchaseOrderStatus,
  type PurchaseOrderSummary,
} from "@/hooks/usePurchaseOrders";
import { useSuppliers } from "@/hooks/useSuppliers";
import { can } from "@/lib/permissions";
import { type DateRangeKey } from "@/components/sales/SalesFilters";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency, formatDate } from "@/lib/i18n/format";

type ToastState = { type: "success" | "error"; message: string } | null;
type PendingAction =
  | { kind: "receive"; id: string }
  | { kind: "cancel"; id: string }
  | { kind: "delete"; id: string }
  | { kind: "deletePayment"; orderId: string; paymentId: string }
  | null;

const ACTION_VARIANT: Record<
  Exclude<PendingAction, null>["kind"],
  "danger" | "primary"
> = {
  receive: "primary",
  cancel: "danger",
  delete: "danger",
  deletePayment: "danger",
};

const STATUS_STYLES: Record<PurchaseOrderStatus, string> = {
  draft: "bg-orange-100 text-orange-700",
  received: "bg-success-light text-success",
  cancelled: "bg-gray-100 text-gray-500",
};

interface PaymentRow {
  id: string;
  amount: number;
  method: string;
  paidAt: Date;
  notes: string | null;
}

/**
 * Resolve a date-range preset to an inclusive [from, to] window. Returns null
 * for "all" (no filtering). Custom uses caller-provided ISO date strings.
 */
function resolveDateWindow(
  key: DateRangeKey,
  customFrom: string,
  customTo: string,
): { from: Date; to: Date } | null {
  if (key === "all") return null;
  const now = new Date();
  const startOfDay = (d: Date) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const endOfDay = (d: Date) => {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
  };
  switch (key) {
    case "today":
      return { from: startOfDay(now), to: endOfDay(now) };
    case "yesterday": {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { from: startOfDay(y), to: endOfDay(y) };
    }
    case "7d": {
      const from = new Date(now);
      from.setDate(from.getDate() - 6);
      return { from: startOfDay(from), to: endOfDay(now) };
    }
    case "30d": {
      const from = new Date(now);
      from.setDate(from.getDate() - 29);
      return { from: startOfDay(from), to: endOfDay(now) };
    }
    case "thisMonth": {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from, to: endOfDay(now) };
    }
    case "custom": {
      if (!customFrom && !customTo) return null;
      const from = customFrom ? startOfDay(new Date(customFrom)) : new Date(0);
      const to = customTo ? endOfDay(new Date(customTo)) : endOfDay(now);
      if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf())) return null;
      return { from, to };
    }
  }
}

function classifyPayment(po: PurchaseOrderSummary): PaymentStatusKey {
  if (po.paidAmount <= 0.001) return "unpaid";
  if (po.paidAmount + 0.001 >= po.total) return "paid";
  return "partial";
}

export default function PurchasesPage() {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.purchases;
  const statusLabels = dict.app.purchasesStatus;
  const { data: session } = useSession();
  const principal = session?.user
    ? { role: session.user.role, permissions: session.user.permissions }
    : null;
  const canManage = can(principal, "manage_purchases");

  // Fetch all orders client-side once; filtering happens in memory so KPI
  // cards reflect the same dataset users see. Volume is typically small.
  const { data: orders, loading, refresh } = usePurchaseOrders();
  const { data: suppliers } = useSuppliers();

  const [query, setQuery] = useState("");
  const [dateRange, setDateRange] = useState<DateRangeKey>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [selectedSupplier, setSelectedSupplier] = useState<string | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<PurchaseOrderStatus | "all">(
    "all",
  );
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatusKey>("all");

  const [builderOpen, setBuilderOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState<PurchaseOrderSummary | null>(null);
  const [paymentsByPo, setPaymentsByPo] = useState<Record<string, PaymentRow[]>>({});

  const filteredOrders = useMemo(() => {
    const window = resolveDateWindow(dateRange, customFrom, customTo);
    const q = query.trim().toLowerCase();
    return orders.filter((o) => {
      if (window) {
        const d = o.receivedDate ?? o.orderDate;
        if (d < window.from || d > window.to) return false;
      }
      if (selectedSupplier && o.supplierId !== selectedSupplier) return false;
      if (selectedStatus !== "all" && o.status !== selectedStatus) return false;
      if (paymentStatus !== "all" && o.status === "received") {
        if (classifyPayment(o) !== paymentStatus) return false;
      } else if (paymentStatus !== "all") {
        // Non-received POs have no payment status — exclude when filtered.
        return false;
      }
      if (q) {
        const haystack = `${o.supplierName} ${o.notes ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [
    orders,
    dateRange,
    customFrom,
    customTo,
    selectedSupplier,
    selectedStatus,
    paymentStatus,
    query,
  ]);

  const rangeLabel = useMemo(() => {
    if (dateRange === "custom") return "";
    return dict.app.dateRange[dateRange];
  }, [dateRange, dict.app.dateRange]);

  // Lazy-load payments for a PO when its row expands.
  const loadPayments = async (poId: string) => {
    if (paymentsByPo[poId]) return;
    try {
      const res = await fetch(`/api/purchase-orders/${poId}/payments`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const json: {
        data: Array<{
          id: string;
          amount: number;
          method: string;
          paidAt: string;
          notes: string | null;
        }>;
      } = await res.json();
      setPaymentsByPo((prev) => ({
        ...prev,
        [poId]: json.data.map((p) => ({
          id: p.id,
          amount: p.amount,
          method: p.method,
          paidAt: new Date(p.paidAt),
          notes: p.notes,
        })),
      }));
    } catch {
      // silent — row will just show "—"
    }
  };

  useEffect(() => {
    if (expanded) loadPayments(expanded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

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
        successMsg = t.toast.receiveSuccess;
        errorMsg = t.toast.receiveFailed;
      } else if (pending.kind === "cancel") {
        res = await fetch(`/api/purchase-orders/${pending.id}/cancel`, {
          method: "POST",
        });
        successMsg = t.toast.cancelSuccess;
        errorMsg = t.toast.cancelFailed;
      } else if (pending.kind === "delete") {
        res = await fetch(`/api/purchase-orders/${pending.id}`, { method: "DELETE" });
        successMsg = t.toast.deleteSuccess;
        errorMsg = t.toast.deleteFailed;
      } else {
        res = await fetch(
          `/api/purchase-orders/${pending.orderId}/payments/${pending.paymentId}`,
          { method: "DELETE" },
        );
        successMsg = t.toast.paymentDeleted;
        errorMsg = t.toast.paymentDeleteFailed;
      }
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setToast({ type: "error", message: json.error || errorMsg });
        return;
      }
      setToast({ type: "success", message: successMsg });
      const wasPayment =
        pending.kind === "deletePayment" ? pending.orderId : null;
      setPending(null);
      if (wasPayment) {
        setPaymentsByPo((prev) => {
          const next = { ...prev };
          delete next[wasPayment];
          return next;
        });
      }
      await refresh();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppShell title={t.title}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">{t.heading}</h1>
            <p className="text-sm text-text-secondary mt-1">
              {t.count.replace("{n}", String(filteredOrders.length))}
            </p>
          </div>
          {canManage && (
            <Button onClick={() => setBuilderOpen(true)}>
              <Plus className="w-4 h-4 me-1" />
              {t.newOrder}
            </Button>
          )}
        </div>

        {/* KPI cards driven by filtered data */}
        <PurchasesKpiCards orders={filteredOrders} rangeLabel={rangeLabel} />

        {/* Filters */}
        <PurchasesFilters
          query={query}
          onQueryChange={setQuery}
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
          selectedSupplier={selectedSupplier}
          onSupplierChange={setSelectedSupplier}
          suppliers={suppliers}
          selectedStatus={selectedStatus}
          onStatusChange={setSelectedStatus}
          paymentStatus={paymentStatus}
          onPaymentStatusChange={setPaymentStatus}
        />

        {/* List */}
        {loading ? (
          <p className="text-sm text-text-secondary">{t.loading}</p>
        ) : filteredOrders.length === 0 ? (
          <div className="bg-white rounded-2xl border border-border py-12 text-center">
            <Receipt className="w-9 h-9 mx-auto mb-4 text-text-secondary" />
            <p className="text-text-secondary">
              {orders.length === 0 ? t.emptyFresh : t.emptyFiltered}
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-border divide-y divide-border">
            {filteredOrders.map((o) => {
              const remaining = Math.max(0, o.total - o.paidAmount);
              const isExpanded = expanded === o.id;
              const paid = o.paidAmount;
              const showPay = canManage && o.status === "received" && remaining > 0.001;
              return (
                <div key={o.id} className="p-4">
                  <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
                    <button
                      type="button"
                      onClick={() => setExpanded(isExpanded ? null : o.id)}
                      className="flex-1 min-w-0 text-right"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-text-primary truncate" dir="auto">
                          {o.supplierName}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${
                            STATUS_STYLES[o.status]
                          }`}
                        >
                          {statusLabels[o.status]}
                        </span>
                        {o.status === "received" && (
                          <PaymentBadge total={o.total} paid={paid} labels={t.paymentBadge} />
                        )}
                        {isExpanded ? (
                          <ChevronUp className="w-4 h-4 text-text-secondary me-auto" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-text-secondary me-auto" />
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary">
                        <span>{t.row.itemCount.replace("{n}", String(o.itemCount))}</span>
                        <span>
                          {t.row.total.replace("{amount}", formatCurrency(o.total, locale))}
                        </span>
                        {o.status === "received" && (
                          <>
                            <span className="text-success">
                              {t.row.paid.replace("{amount}", formatCurrency(paid, locale))}
                            </span>
                            <span className={remaining > 0 ? "text-danger" : ""}>
                              {t.row.remaining.replace("{amount}", formatCurrency(remaining, locale))}
                            </span>
                          </>
                        )}
                        <span>
                          {o.status === "received" && o.receivedDate
                            ? t.row.received.replace("{date}", formatDate(o.receivedDate, locale))
                            : t.row.ordered.replace("{date}", formatDate(o.orderDate, locale))}
                        </span>
                      </div>
                      {o.notes && (
                        <p className="text-xs text-text-secondary mt-1 truncate" dir="auto">
                          {o.notes}
                        </p>
                      )}
                    </button>

                    {canManage && (
                      <div className="flex gap-2 shrink-0">
                        {showPay && (
                          <Button size="sm" onClick={() => setPayOpen(o)}>
                            <Wallet className="w-4 h-4 me-1" />
                            {t.row.pay}
                          </Button>
                        )}
                        {o.status === "draft" && (
                          <>
                            <Button
                              size="sm"
                              onClick={() => setPending({ kind: "receive", id: o.id })}
                            >
                              <CheckCircle className="w-4 h-4 me-1" />
                              {t.row.receive}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setPending({ kind: "cancel", id: o.id })}
                            >
                              <XCircle className="w-4 h-4 me-1" />
                              {t.row.cancel}
                            </Button>
                            <button
                              type="button"
                              onClick={() => setPending({ kind: "delete", id: o.id })}
                              className="p-2 rounded-md text-text-secondary hover:bg-danger-light hover:text-danger"
                              title={t.row.deleteTitle}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  {isExpanded && o.status === "received" && (
                    <PaymentsList
                      payments={paymentsByPo[o.id]}
                      canManage={canManage}
                      onDelete={(paymentId) =>
                        setPending({ kind: "deletePayment", orderId: o.id, paymentId })
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <PurchaseOrderBuilder
        isOpen={builderOpen}
        onClose={() => setBuilderOpen(false)}
        onSaved={async () => {
          setToast({ type: "success", message: t.toast.created });
          await refresh();
        }}
        onError={(message) => setToast({ type: "error", message })}
      />

      {payOpen && (
        <PaymentModal
          isOpen={!!payOpen}
          onClose={() => setPayOpen(null)}
          purchaseOrderId={payOpen.id}
          supplierName={payOpen.supplierName}
          total={payOpen.total}
          paidAmount={payOpen.paidAmount}
          onSaved={async () => {
            setToast({ type: "success", message: t.toast.paymentRecorded });
            setPaymentsByPo((prev) => {
              const next = { ...prev };
              delete next[payOpen.id];
              return next;
            });
            await refresh();
          }}
          onError={(message) => setToast({ type: "error", message })}
        />
      )}

      <ConfirmDialog
        isOpen={!!pending}
        onClose={() => !submitting && setPending(null)}
        onConfirm={runPending}
        title={pending ? t.actions[pending.kind].title : ""}
        message={pending ? t.actions[pending.kind].message : ""}
        confirmText={pending ? t.actions[pending.kind].confirm : t.actions.defaultConfirm}
        variant={pending ? ACTION_VARIANT[pending.kind] : "danger"}
        loading={submitting}
      />

      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
    </AppShell>
  );
}

function PaymentBadge({
  total,
  paid,
  labels,
}: {
  total: number;
  paid: number;
  labels: { paid: string; partial: string; unpaid: string };
}) {
  const status = paid <= 0.001 ? "unpaid" : paid + 0.001 >= total ? "paid" : "partial";
  const styles =
    status === "paid"
      ? "bg-success-light text-success"
      : status === "partial"
        ? "bg-orange-100 text-orange-700"
        : "bg-gray-100 text-gray-600";
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 ${styles}`}>
      {labels[status]}
    </span>
  );
}

function PaymentsList({
  payments,
  canManage,
  onDelete,
}: {
  payments: PaymentRow[] | undefined;
  canManage: boolean;
  onDelete: (paymentId: string) => void;
}) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.purchases;
  if (payments === undefined) {
    return <p className="text-xs text-text-secondary mt-3">{t.loadingPayments}</p>;
  }
  if (payments.length === 0) {
    return (
      <p className="text-xs text-text-secondary mt-3">
        {t.noPayments}
      </p>
    );
  }
  return (
    <div className="mt-3 rounded-lg border border-border bg-gray-50 divide-y divide-border">
      {payments.map((p) => {
        const methodLabel =
          (t.paymentMethod as Record<string, string>)[p.method] ?? p.method;
        return (
          <div
            key={p.id}
            className="flex items-center justify-between gap-2 p-2.5 text-xs"
          >
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                <span className="font-bold text-success">
                  {formatCurrency(p.amount, locale)}
                </span>
                <span className="text-text-secondary">· {methodLabel}</span>
                <span className="text-text-secondary">
                  · {formatDate(p.paidAt, locale)}
                </span>
              </div>
              {p.notes && (
                <p className="text-text-secondary mt-0.5 truncate" dir="auto">
                  {p.notes}
                </p>
              )}
            </div>
            {canManage && (
              <button
                type="button"
                onClick={() => onDelete(p.id)}
                className="p-1.5 rounded-md text-text-secondary hover:bg-danger-light hover:text-danger shrink-0"
                title={t.actions.deletePayment.deleteRowTitle}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
