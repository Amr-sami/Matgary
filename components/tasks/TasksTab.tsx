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
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatDate } from "@/lib/i18n/format";

type Toast = { type: "success" | "error"; message: string };

interface Props {
  onToast: (t: Toast) => void;
  onUnreadChange: () => void;
}

interface TeamMemberOption {
  userId: string;
  displayName: string;
  role: string;
}

const PRIORITY_TONES: Record<TaskPriority, string> = {
  low: "bg-gray-100 text-text-secondary",
  normal: "bg-accent-light text-accent",
  high: "bg-danger-light text-danger",
};

const KANBAN_COLUMNS: TaskStatus[] = ["open", "in_progress", "done"];

export function TasksTab({ onToast, onUnreadChange }: Props) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.tasks;
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

  const myUnreadIds = useMemo(
    () =>
      tasks
        .filter(
          (task) =>
            task.assignedToUserId === session?.user?.id &&
            !task.assigneeSeenAt &&
            (task.status === "open" || task.status === "in_progress"),
        )
        .map((task) => task.id)
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
    for (const task of visibleTasks) out[task.status].push(task);
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
      onToast({ type: "error", message: json.error || t.toast.statusFailed });
      return;
    }
    onToast({ type: "success", message: t.toast.statusSuccess });
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
        onToast({ type: "error", message: json.error || t.toast.deleteFailed });
        return;
      }
      onToast({ type: "success", message: t.toast.deleted });
      setDeleteTarget(null);
      await refresh();
      onUnreadChange();
    } finally {
      setDeleting(false);
    }
  };

  const renderCard = (task: TaskItem) => {
    const isMine = task.assignedToUserId === myUserId;
    const unreadByMe = isMine && !task.assigneeSeenAt && task.status !== "done";
    const overdue =
      task.dueDate && task.status !== "done" && task.dueDate.getTime() < Date.now();

    return (
      <div
        key={task.id}
        className={[
          "rounded-xl border bg-white p-3 space-y-2 transition-colors",
          unreadByMe
            ? "border-accent shadow-[0_0_0_3px_rgba(99,102,241,0.08)]"
            : "border-border",
        ].join(" ")}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="font-medium text-sm text-text-primary leading-snug flex-1" dir="auto">
            {task.title}
          </p>
          {unreadByMe && (
            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-accent text-white font-bold">
              {t.card.newBadge}
            </span>
          )}
        </div>

        {task.description && (
          <p className="text-xs text-text-secondary line-clamp-2" dir="auto">{task.description}</p>
        )}

        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span
            className={`px-1.5 py-0.5 rounded-full font-medium ${PRIORITY_TONES[task.priority]}`}
          >
            {t.priority[task.priority]}
          </span>
          {task.assignedToName && (
            <span className="px-1.5 py-0.5 rounded-full bg-bg-main text-text-secondary" dir="auto">
              {task.assignedToName}
            </span>
          )}
          {task.dueDate && (
            <span
              className={[
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full",
                overdue
                  ? "bg-danger-light text-danger font-medium"
                  : "bg-bg-main text-text-secondary",
              ].join(" ")}
            >
              <Clock className="w-3 h-3" />
              {formatDate(task.dueDate, locale)}
            </span>
          )}
        </div>

        <div className="flex items-center justify-between pt-1 border-t border-border">
          <div className="flex gap-1">
            {(isMine || isManager) && task.status !== "done" && (
              <>
                {task.status === "open" && (
                  <button
                    type="button"
                    onClick={() => updateStatus(task.id, "in_progress")}
                    className="text-xs text-accent hover:underline inline-flex items-center gap-1"
                  >
                    <Clock className="w-3 h-3" />
                    {t.card.startAction}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => updateStatus(task.id, "done")}
                  className="text-xs text-success hover:underline inline-flex items-center gap-1"
                >
                  <Check className="w-3 h-3" />
                  {t.card.doneAction}
                </button>
              </>
            )}
            {task.status === "done" && isManager && (
              <button
                type="button"
                onClick={() => updateStatus(task.id, "open")}
                className="text-xs text-text-secondary hover:text-accent"
              >
                {t.card.reopenAction}
              </button>
            )}
          </div>
          {isManager && (
            <div className="flex gap-0.5">
              <button
                type="button"
                onClick={() => {
                  setEditTarget(task);
                  setFormOpen(true);
                }}
                className="p-1 rounded hover:bg-bg-main text-text-secondary hover:text-accent"
                title={t.card.editTitle}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setDeleteTarget(task)}
                className="p-1 rounded hover:bg-danger-light text-text-secondary hover:text-danger"
                title={t.card.deleteTitle}
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
            {t.toolbar.board}
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
            {t.toolbar.list}
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
            {t.toolbar.newTask}
          </Button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary text-center py-8">{t.empty.loading}</p>
      ) : tasks.length === 0 ? (
        <div className="bg-white rounded-2xl border border-border py-12 text-center">
          <ListChecks className="w-9 h-9 mx-auto mb-3 text-accent" />
          <p className="text-sm font-medium text-text-primary mb-1">
            {isManager ? t.empty.managerTitle : t.empty.staffTitle}
          </p>
          <p className="text-xs text-text-secondary mb-4 max-w-xs mx-auto">
            {isManager ? t.empty.managerHint : t.empty.staffHint}
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
              {t.empty.createButton}
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
                  {t.status[col]}
                </h3>
                <span className="text-xs text-text-secondary">
                  {grouped[col].length}
                </span>
              </div>
              <div className="bg-bg-main/40 rounded-2xl p-2 min-h-[140px] space-y-2">
                {grouped[col].length === 0 ? (
                  <p className="text-xs text-text-secondary text-center py-6">
                    {t.empty.columnEmpty}
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
          {visibleTasks.map((task) => (
            <div key={task.id} className="p-3">
              {renderCard(task)}
            </div>
          ))}
        </div>
      )}

      {openCount > 0 && (
        <p className="text-xs text-text-secondary text-center">
          {t.openCount.replace("{n}", String(openCount))}
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
            message: editTarget ? t.toast.edited : t.toast.created,
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
        title={t.delete.title}
        message={
          deleteTarget
            ? t.delete.message.replace("{title}", deleteTarget.title)
            : ""
        }
        confirmText={t.delete.confirm}
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
