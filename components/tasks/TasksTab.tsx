"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Plus,
  ListChecks,
  Pencil,
  Trash2,
  Check,
  Clock,
} from "@/lib/icons";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TaskFormModal } from "./TaskFormModal";
import { useTasks, type TaskItem, type TaskStatus, type TaskPriority } from "@/hooks/useTasks";
import { can } from "@/lib/permissions";

type Toast = { type: "success" | "error"; message: string };

interface Props {
  onToast: (t: Toast) => void;
  /** Called whenever the unread badge count needs to refresh. */
  onUnreadChange: () => void;
}

interface TeamMemberOption {
  userId: string;
  displayName: string;
  role: string;
}

const STATUS_TITLES: Record<TaskStatus, string> = {
  open: "مفتوحة",
  in_progress: "قيد التنفيذ",
  done: "مكتملة",
  cancelled: "ملغاة",
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "منخفضة",
  normal: "عادية",
  high: "عاجلة",
};

const PRIORITY_TONES: Record<TaskPriority, string> = {
  low: "bg-gray-100 text-text-secondary",
  normal: "bg-accent-light text-accent",
  high: "bg-danger-light text-danger",
};

const KANBAN_COLUMNS: TaskStatus[] = ["open", "in_progress", "done"];

export function TasksTab({ onToast, onUnreadChange }: Props) {
  const { data: session } = useSession();
  const principal = session?.user
    ? { role: session.user.role, permissions: session.user.permissions }
    : null;
  const isManager = can(principal, "manage_tasks");

  const { data: tasks, loading, refresh } = useTasks();
  const [members, setMembers] = useState<TeamMemberOption[]>([]);
  const [view, setView] = useState<"board" | "list">("board");

  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TaskItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Messenger-style read flow: any unseen task assigned to the current user
  // is acknowledged the moment they're looking at this page. This runs after
  // every poll-driven refresh, so a task that arrives while the user is on
  // the page is also auto-seen and the badge stays at zero.
  const myUnreadIds = useMemo(
    () =>
      tasks
        .filter(
          (t) =>
            t.assignedToUserId === session?.user?.id &&
            !t.assigneeSeenAt &&
            (t.status === "open" || t.status === "in_progress"),
        )
        .map((t) => t.id)
        .join(","),
    [tasks, session?.user?.id],
  );

  useEffect(() => {
    if (!myUnreadIds) return;
    let cancelled = false;
    (async () => {
      try {
        await fetch("/api/tasks/seen", { method: "POST" });
        if (!cancelled) {
          await refresh();
          onUnreadChange();
        }
      } catch {
        // ignore — best-effort
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myUnreadIds]);

  // Manager fetches the team list for the assignee picker.
  useEffect(() => {
    if (!isManager) return;
    (async () => {
      try {
        const res = await fetch("/api/team", { cache: "no-store" });
        if (!res.ok) return;
        const json: { data: { userId: string; displayName: string; role: string }[] } =
          await res.json();
        setMembers(
          json.data.map((m) => ({
            userId: m.userId,
            displayName: m.displayName,
            role: m.role,
          })),
        );
      } catch {
        // ignore — assignee picker will be empty
      }
    })();
  }, [isManager]);

  const myUserId = session?.user?.id;

  const visibleTasks = useMemo(() => {
    // API already filters by permission; client just sorts: unread first, then due date asc.
    const sorted = [...tasks];
    sorted.sort((a, b) => {
      const aUnread = !a.assigneeSeenAt && a.assignedToUserId === myUserId ? 0 : 1;
      const bUnread = !b.assigneeSeenAt && b.assignedToUserId === myUserId ? 0 : 1;
      if (aUnread !== bUnread) return aUnread - bUnread;
      const aDue = a.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bDue = b.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return aDue - bDue;
    });
    return sorted;
  }, [tasks, myUserId]);

  const grouped = useMemo(() => {
    const out: Record<TaskStatus, TaskItem[]> = {
      open: [],
      in_progress: [],
      done: [],
      cancelled: [],
    };
    for (const t of visibleTasks) out[t.status].push(t);
    return out;
  }, [visibleTasks]);

  const updateStatus = async (taskId: string, status: TaskStatus) => {
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      onToast({ type: "error", message: json.error || "تعذر تحديث الحالة" });
      return;
    }
    onToast({ type: "success", message: "تم تحديث الحالة" });
    await refresh();
    onUnreadChange();
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/tasks/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        onToast({ type: "error", message: json.error || "تعذر الحذف" });
        return;
      }
      onToast({ type: "success", message: "تم الحذف" });
      setDeleteTarget(null);
      await refresh();
      onUnreadChange();
    } finally {
      setDeleting(false);
    }
  };

  const renderCard = (t: TaskItem) => {
    const isMine = t.assignedToUserId === myUserId;
    const unreadByMe = isMine && !t.assigneeSeenAt && t.status !== "done";
    const overdue =
      t.dueDate && t.status !== "done" && t.dueDate.getTime() < Date.now();

    return (
      <div
        key={t.id}
        className={[
          "rounded-xl border bg-white p-3 space-y-2 transition-colors",
          unreadByMe
            ? "border-accent shadow-[0_0_0_3px_rgba(99,102,241,0.08)]"
            : "border-border",
        ].join(" ")}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="font-medium text-sm text-text-primary leading-snug flex-1">
            {t.title}
          </p>
          {unreadByMe && (
            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-accent text-white font-bold">
              جديدة
            </span>
          )}
        </div>

        {t.description && (
          <p className="text-xs text-text-secondary line-clamp-2">{t.description}</p>
        )}

        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span
            className={`px-1.5 py-0.5 rounded-full font-medium ${PRIORITY_TONES[t.priority]}`}
          >
            {PRIORITY_LABELS[t.priority]}
          </span>
          {t.assignedToName && (
            <span className="px-1.5 py-0.5 rounded-full bg-bg-main text-text-secondary">
              {t.assignedToName}
            </span>
          )}
          {t.dueDate && (
            <span
              className={[
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full",
                overdue
                  ? "bg-danger-light text-danger font-medium"
                  : "bg-bg-main text-text-secondary",
              ].join(" ")}
            >
              <Clock className="w-3 h-3" />
              {t.dueDate.toLocaleDateString("ar-EG")}
            </span>
          )}
        </div>

        {/* Action row */}
        <div className="flex items-center justify-between pt-1 border-t border-border">
          <div className="flex gap-1">
            {(isMine || isManager) && t.status !== "done" && (
              <>
                {t.status === "open" && (
                  <button
                    type="button"
                    onClick={() => updateStatus(t.id, "in_progress")}
                    className="text-xs text-accent hover:underline inline-flex items-center gap-1"
                  >
                    <Clock className="w-3 h-3" />
                    ابدأ
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => updateStatus(t.id, "done")}
                  className="text-xs text-success hover:underline inline-flex items-center gap-1"
                >
                  <Check className="w-3 h-3" />
                  تم الإنجاز
                </button>
              </>
            )}
            {t.status === "done" && isManager && (
              <button
                type="button"
                onClick={() => updateStatus(t.id, "open")}
                className="text-xs text-text-secondary hover:text-accent"
              >
                إعادة فتح
              </button>
            )}
          </div>
          {isManager && (
            <div className="flex gap-0.5">
              <button
                type="button"
                onClick={() => {
                  setEditTarget(t);
                  setFormOpen(true);
                }}
                className="p-1 rounded hover:bg-bg-main text-text-secondary hover:text-accent"
                title="تعديل"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setDeleteTarget(t)}
                className="p-1 rounded hover:bg-danger-light text-text-secondary hover:text-danger"
                title="حذف"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const openCount = grouped.open.length + grouped.in_progress.length;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 bg-bg-card border border-border rounded-xl p-1">
          <button
            type="button"
            onClick={() => setView("board")}
            className={[
              "px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
              view === "board"
                ? "bg-white text-text-primary shadow-sm"
                : "text-text-secondary",
            ].join(" ")}
          >
            لوحة
          </button>
          <button
            type="button"
            onClick={() => setView("list")}
            className={[
              "px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
              view === "list"
                ? "bg-white text-text-primary shadow-sm"
                : "text-text-secondary",
            ].join(" ")}
          >
            قائمة
          </button>
        </div>
        {isManager && (
          <Button
            onClick={() => {
              setEditTarget(null);
              setFormOpen(true);
            }}
          >
            <Plus className="w-4 h-4 me-1" />
            مهمة جديدة
          </Button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary text-center py-8">جاري التحميل…</p>
      ) : tasks.length === 0 ? (
        <div className="bg-white rounded-2xl border border-border py-12 text-center">
          <ListChecks className="w-9 h-9 mx-auto mb-3 text-accent" />
          <p className="text-sm font-medium text-text-primary mb-1">
            {isManager ? "لا توجد مهام بعد" : "لا توجد مهام موكلة إليك"}
          </p>
          <p className="text-xs text-text-secondary mb-4 max-w-xs mx-auto">
            {isManager
              ? "أنشئ مهام وحدد الموظف المسؤول وموعد التنفيذ. سيرى الموظف إشعاراً فور إسناد المهمة."
              : "ستظهر هنا أي مهمة يسندها لك المدير."}
          </p>
          {isManager && (
            <Button
              size="sm"
              onClick={() => {
                setEditTarget(null);
                setFormOpen(true);
              }}
            >
              <Plus className="w-4 h-4 me-1" />
              إنشاء مهمة
            </Button>
          )}
        </div>
      ) : view === "board" ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {KANBAN_COLUMNS.map((col) => (
            <div key={col} className="space-y-2">
              <div className="flex items-center justify-between gap-2 px-1">
                <h3 className="text-sm font-semibold text-text-primary flex items-center gap-1.5">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      col === "open"
                        ? "bg-orange-500"
                        : col === "in_progress"
                          ? "bg-accent"
                          : "bg-success"
                    }`}
                  />
                  {STATUS_TITLES[col]}
                </h3>
                <span className="text-xs text-text-secondary">
                  {grouped[col].length}
                </span>
              </div>
              <div className="bg-bg-main/40 rounded-2xl p-2 min-h-[140px] space-y-2">
                {grouped[col].length === 0 ? (
                  <p className="text-xs text-text-secondary text-center py-6">
                    لا شيء هنا
                  </p>
                ) : (
                  grouped[col].map(renderCard)
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-border divide-y divide-border">
          {visibleTasks.map((t) => (
            <div key={t.id} className="p-3">
              {renderCard(t)}
            </div>
          ))}
        </div>
      )}

      {openCount > 0 && (
        <p className="text-xs text-text-secondary text-center">
          {openCount} مهمة مفتوحة
        </p>
      )}

      <TaskFormModal
        isOpen={formOpen}
        task={editTarget}
        members={members}
        onClose={() => setFormOpen(false)}
        onSaved={async () => {
          onToast({
            type: "success",
            message: editTarget ? "تم حفظ التعديلات" : "تم إنشاء المهمة",
          });
          await refresh();
          onUnreadChange();
        }}
        onError={(message) => onToast({ type: "error", message })}
      />

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => !deleting && setDeleteTarget(null)}
        onConfirm={remove}
        title="حذف المهمة"
        message={
          deleteTarget
            ? `هل تريد حذف "${deleteTarget.title}"؟ هذا الإجراء لا يمكن التراجع عنه.`
            : ""
        }
        confirmText="حذف"
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
