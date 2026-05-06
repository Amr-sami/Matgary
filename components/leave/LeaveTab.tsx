"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Plus,
  Calendar,
  CheckCircle,
  XCircle,
  Clock,
  Trash2,
} from "@/lib/icons";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useLeaveRequests, type LeaveStatus, type LeaveRequestItem } from "@/hooks/useLeaveRequests";
import { can } from "@/lib/permissions";

type Toast = { type: "success" | "error"; message: string };

interface Props {
  onToast: (t: Toast) => void;
  /** Optional: called whenever the global leave unread badge needs to refresh. */
  onUnreadChange?: () => void;
}

const STATUS_LABEL: Record<LeaveStatus, string> = {
  pending: "بانتظار الرد",
  approved: "تمت الموافقة",
  rejected: "مرفوض",
};

const STATUS_TONE: Record<LeaveStatus, string> = {
  pending: "bg-orange-50 text-orange-700",
  approved: "bg-success-light text-success",
  rejected: "bg-danger-light text-danger",
};

const formatRange = (a: Date, b: Date): string => {
  const sameDay = a.toDateString() === b.toDateString();
  if (sameDay) return a.toLocaleDateString("ar-EG");
  return `${a.toLocaleDateString("ar-EG")} – ${b.toLocaleDateString("ar-EG")}`;
};

const daysBetween = (a: Date, b: Date): number => {
  const ms = b.getTime() - a.getTime();
  return Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24)) + 1);
};

export function LeaveTab({ onToast, onUnreadChange }: Props) {
  const { data: session } = useSession();
  const principal = session?.user
    ? { role: session.user.role, permissions: session.user.permissions }
    : null;
  const isManager = can(principal, "manage_leave");
  const canRequest = can(principal, "request_leave");

  const { data: items, loading, refresh } = useLeaveRequests();
  const myUserId = session?.user?.id;

  // Mark every leave-related notification as read whenever this tab is open
  // and the data changes. Mirrors the tasks "messenger-style" read flow.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await fetch("/api/leave-requests/seen", { method: "POST" });
        if (!cancelled) onUnreadChange?.();
      } catch {
        // best-effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items.length, onUnreadChange]);

  const pendingCount = useMemo(
    () => items.filter((i) => i.status === "pending").length,
    [items],
  );

  const [formOpen, setFormOpen] = useState(false);
  const [decideTarget, setDecideTarget] = useState<{
    item: LeaveRequestItem;
    status: "approved" | "rejected";
  } | null>(null);
  const [decideNote, setDecideNote] = useState("");
  const [deciding, setDeciding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LeaveRequestItem | null>(null);

  const submit = async (start: string, end: string, reason: string) => {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const res = await fetch("/api/leave-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        reason: reason.trim() || null,
      }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      onToast({ type: "error", message: json.error || "تعذر التقديم" });
      return false;
    }
    onToast({ type: "success", message: "تم تقديم الطلب" });
    await refresh();
    return true;
  };

  const decide = async () => {
    if (!decideTarget) return;
    setDeciding(true);
    try {
      const res = await fetch(
        `/api/leave-requests/${decideTarget.item.id}/decide`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: decideTarget.status,
            note: decideNote.trim() || null,
          }),
        },
      );
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        onToast({ type: "error", message: json.error || "تعذر الحفظ" });
        return;
      }
      onToast({
        type: "success",
        message:
          decideTarget.status === "approved" ? "تمت الموافقة" : "تم الرفض",
      });
      setDecideTarget(null);
      setDecideNote("");
      await refresh();
    } finally {
      setDeciding(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    const res = await fetch(`/api/leave-requests/${deleteTarget.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      onToast({ type: "error", message: json.error || "تعذر الحذف" });
      return;
    }
    onToast({ type: "success", message: "تم الحذف" });
    setDeleteTarget(null);
    await refresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {isManager && pendingCount > 0 && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm bg-orange-50 text-orange-700 font-medium">
              <Clock className="w-4 h-4" />
              {pendingCount} طلب بانتظار الرد
            </span>
          )}
        </div>
        {canRequest && (
          <Button onClick={() => setFormOpen(true)}>
            <Plus className="w-4 h-4 me-1" />
            طلب إجازة
          </Button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary text-center py-8">جاري التحميل…</p>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-2xl border border-border py-12 text-center">
          <div className="w-14 h-14 mx-auto mb-3 rounded-full bg-accent-light text-accent flex items-center justify-center">
            <Calendar className="w-7 h-7" />
          </div>
          <p className="text-sm font-medium text-text-primary mb-1">
            لا توجد طلبات إجازة
          </p>
          <p className="text-xs text-text-secondary mb-4 max-w-xs mx-auto">
            {isManager
              ? "ستظهر طلبات الموظفين هنا حالما يقدّمونها."
              : "قدّم أول طلب إجازة. سيرى المدير الطلب وسيتم إعلامك بالقرار."}
          </p>
          {canRequest && (
            <Button size="sm" onClick={() => setFormOpen(true)}>
              <Plus className="w-4 h-4 me-1" />
              طلب جديد
            </Button>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-border divide-y divide-border">
          {items.map((it) => {
            const isMine = it.userId === myUserId;
            const canDelete =
              (isMine && it.status === "pending") || isManager;
            return (
              <div key={it.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                          STATUS_TONE[it.status]
                        }`}
                      >
                        {STATUS_LABEL[it.status]}
                      </span>
                      {isManager && it.userName && (
                        <span className="text-sm font-medium text-text-primary">
                          {it.userName}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-text-primary">
                      <Calendar className="w-3.5 h-3.5 inline-block me-1" />
                      {formatRange(it.startDate, it.endDate)}
                      <span className="text-text-secondary">
                        {" "}
                        ({daysBetween(it.startDate, it.endDate)} يوم)
                      </span>
                    </p>
                    {it.reason && (
                      <p className="text-xs text-text-secondary mt-1">
                        <span className="font-medium">السبب:</span> {it.reason}
                      </p>
                    )}
                    {it.status !== "pending" && it.decisionNote && (
                      <p className="text-xs text-text-secondary mt-1">
                        <span className="font-medium">ملاحظة:</span>{" "}
                        {it.decisionNote}
                      </p>
                    )}
                    {it.decidedAt && it.decidedByName && (
                      <p className="text-[10px] text-text-secondary mt-1">
                        قرار من {it.decidedByName} ·{" "}
                        {it.decidedAt.toLocaleDateString("ar-EG")}
                      </p>
                    )}
                  </div>

                  <div className="flex gap-1 shrink-0">
                    {isManager && it.status === "pending" && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => {
                            setDecideTarget({ item: it, status: "approved" });
                            setDecideNote("");
                          }}
                        >
                          <CheckCircle className="w-4 h-4 me-1" />
                          قبول
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setDecideTarget({ item: it, status: "rejected" });
                            setDecideNote("");
                          }}
                        >
                          <XCircle className="w-4 h-4 me-1" />
                          رفض
                        </Button>
                      </>
                    )}
                    {canDelete && (
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(it)}
                        className="p-2 rounded-md text-text-secondary hover:bg-danger-light hover:text-danger"
                        title="حذف"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <LeaveFormModal
        isOpen={formOpen}
        onClose={() => setFormOpen(false)}
        onSubmit={async (s, e, r) => {
          const ok = await submit(s, e, r);
          if (ok) setFormOpen(false);
        }}
      />

      <Modal
        isOpen={!!decideTarget}
        onClose={() => !deciding && setDecideTarget(null)}
        title={
          decideTarget?.status === "approved" ? "قبول الطلب" : "رفض الطلب"
        }
      >
        {decideTarget && (
          <div className="space-y-4">
            <p className="text-sm text-text-secondary">
              {decideTarget.item.userName ?? "موظف"} —{" "}
              {formatRange(
                decideTarget.item.startDate,
                decideTarget.item.endDate,
              )}
            </p>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">
                ملاحظة (اختياري)
              </label>
              <textarea
                dir="rtl"
                rows={2}
                value={decideNote}
                onChange={(e) => setDecideNote(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                variant="secondary"
                onClick={() => setDecideTarget(null)}
                disabled={deciding}
              >
                إلغاء
              </Button>
              <Button
                variant={decideTarget.status === "rejected" ? "danger" : "primary"}
                onClick={decide}
                loading={deciding}
              >
                {decideTarget.status === "approved" ? "قبول" : "رفض"}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={remove}
        title="حذف الطلب"
        message="هل تريد حذف هذا الطلب نهائياً؟"
        confirmText="حذف"
        variant="danger"
      />
    </div>
  );
}

function LeaveFormModal({
  isOpen,
  onClose,
  onSubmit,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (start: string, end: string, reason: string) => void | Promise<void>;
}) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // reset when opening
  useEffect(() => {
    if (isOpen) {
      const today = new Date().toISOString().slice(0, 10);
      setStart(today);
      setEnd(today);
      setReason("");
    }
  }, [isOpen]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="طلب إجازة جديد">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              من
            </label>
            <input
              type="date"
              dir="ltr"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              إلى
            </label>
            <input
              type="date"
              dir="ltr"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            السبب (اختياري)
          </label>
          <textarea
            dir="rtl"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثلاً: ظرف عائلي، سفر..."
            className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
          />
        </div>
        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            إلغاء
          </Button>
          <Button
            onClick={async () => {
              if (!start || !end) return;
              setSubmitting(true);
              try {
                await onSubmit(start, end, reason);
              } finally {
                setSubmitting(false);
              }
            }}
            loading={submitting}
            disabled={!start || !end}
          >
            تقديم الطلب
          </Button>
        </div>
      </div>
    </Modal>
  );
}
