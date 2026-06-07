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
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useLeaveRequests, type LeaveRequestItem } from "@/hooks/useLeaveRequests";
import { can } from "@/lib/permissions";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatDate } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/config";

type Toast = { type: "success" | "error"; message: string };

interface Props {
  onToast: (t: Toast) => void;
  /** Optional: called whenever the global leave unread badge needs to refresh. */
  onUnreadChange?: () => void;
}

const formatRange = (a: Date, b: Date, locale: Locale, separator: string): string => {
  const sameDay = a.toDateString() === b.toDateString();
  if (sameDay) return formatDate(a, locale);
  return `${formatDate(a, locale)}${separator}${formatDate(b, locale)}`;
};

const daysBetween = (a: Date, b: Date): number => {
  const ms = b.getTime() - a.getTime();
  return Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24)) + 1);
};

export function LeaveTab({ onToast, onUnreadChange }: Props) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.leave;
  const STATUS_LABEL = t.status;
  const STATUS_TONE = {
    pending: "bg-orange-50 text-orange-700",
    approved: "bg-success-light text-success",
    rejected: "bg-danger-light text-danger",
  } as const;
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
      onToast({ type: "error", message: json.error || t.tab.toast.submitFailed });
      return false;
    }
    onToast({ type: "success", message: t.tab.toast.submitted });
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
        onToast({ type: "error", message: json.error || t.tab.toast.saveFailed });
        return;
      }
      onToast({
        type: "success",
        message:
          decideTarget.status === "approved" ? t.tab.toast.approved : t.tab.toast.rejected,
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
      onToast({ type: "error", message: json.error || t.tab.toast.deleteFailed });
      return;
    }
    onToast({ type: "success", message: t.tab.toast.deleted });
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
              {t.tab.pendingCount.replace("{n}", String(pendingCount))}
            </span>
          )}
        </div>
        {canRequest && (
          <Button onClick={() => setFormOpen(true)}>
            <Plus className="w-4 h-4 me-1" />
            {t.tab.request}
          </Button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary text-center py-8">{t.tab.loading}</p>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-2xl border border-border py-12 text-center">
          <div className="w-14 h-14 mx-auto mb-3 rounded-full bg-accent-light text-accent flex items-center justify-center">
            <Calendar className="w-7 h-7" />
          </div>
          <p className="text-sm font-medium text-text-primary mb-1">
            {t.tab.emptyTitle}
          </p>
          <p className="text-xs text-text-secondary mb-4 max-w-xs mx-auto">
            {isManager ? t.tab.emptyManager : t.tab.emptyEmployee}
          </p>
          {canRequest && (
            <Button size="sm" onClick={() => setFormOpen(true)}>
              <Plus className="w-4 h-4 me-1" />
              {t.tab.newRequest}
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
                        <span className="text-sm font-medium text-text-primary" dir="auto">
                          {it.userName}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-text-primary">
                      <Calendar className="w-3.5 h-3.5 inline-block me-1" />
                      {formatRange(it.startDate, it.endDate, locale, t.range.separator)}
                      <span className="text-text-secondary">
                        {" "}
                        {t.tab.daysSuffix.replace(
                          "{n}",
                          String(daysBetween(it.startDate, it.endDate)),
                        )}
                      </span>
                    </p>
                    {it.reason && (
                      <p className="text-xs text-text-secondary mt-1">
                        <span className="font-medium">{t.tab.reasonLabel}</span>{" "}
                        <span dir="auto">{it.reason}</span>
                      </p>
                    )}
                    {it.status !== "pending" && it.decisionNote && (
                      <p className="text-xs text-text-secondary mt-1">
                        <span className="font-medium">{t.tab.noteLabel}</span>{" "}
                        <span dir="auto">{it.decisionNote}</span>
                      </p>
                    )}
                    {it.decidedAt && it.decidedByName && (
                      <p className="text-[10px] text-text-secondary mt-1">
                        {t.tab.decisionBy
                          .replace("{name}", it.decidedByName)
                          .replace("{date}", formatDate(it.decidedAt, locale))}
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
                          {t.tab.approve}
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
                          {t.tab.reject}
                        </Button>
                      </>
                    )}
                    {canDelete && (
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(it)}
                        className="p-2 rounded-md text-text-secondary hover:bg-danger-light hover:text-danger"
                        title={t.tab.deleteTitle}
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
          decideTarget?.status === "approved"
            ? t.tab.decision.approveTitle
            : t.tab.decision.rejectTitle
        }
      >
        {decideTarget && (
          <div className="space-y-4">
            <p className="text-sm text-text-secondary">
              <span dir="auto">{decideTarget.item.userName ?? t.tab.anonymousEmployee}</span>
              {" — "}
              {formatRange(
                decideTarget.item.startDate,
                decideTarget.item.endDate,
                locale,
                t.range.separator,
              )}
            </p>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">
                {t.tab.decision.noteOptional}
              </label>
              <textarea
                dir="auto"
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
                {t.tab.decision.cancel}
              </Button>
              <Button
                variant={decideTarget.status === "rejected" ? "danger" : "primary"}
                onClick={decide}
                loading={deciding}
              >
                {decideTarget.status === "approved"
                  ? t.tab.decision.approveButton
                  : t.tab.decision.rejectButton}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={remove}
        title={t.tab.deleteDialog.title}
        message={t.tab.deleteDialog.message}
        confirmText={t.tab.deleteDialog.confirm}
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
  const dict = useDictionary();
  const t = dict.app.leave.form;
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
    <Modal isOpen={isOpen} onClose={onClose} title={t.title}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              {t.from}
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
              {t.to}
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
            {t.reasonLabel}
          </label>
          <textarea
            dir="auto"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t.reasonPlaceholder}
            className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
          />
        </div>
        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t.cancel}
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
            {t.submit}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
