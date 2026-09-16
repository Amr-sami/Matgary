"use client";

import { useEffect, useState } from "react";
import { Save, Plus } from "@/lib/icons";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import type { TaskItem, TaskPriority } from "@/hooks/useTasks";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface TeamMemberOption {
  userId: string;
  displayName: string;
  role: string;
}

interface Props {
  isOpen: boolean;
  task: TaskItem | null;
  members: TeamMemberOption[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (msg: string) => void;
}

const PRIORITY_KEYS: TaskPriority[] = ["low", "normal", "high"];

export function TaskFormModal({ isOpen, task, members, onClose, onSaved, onError }: Props) {
  const dict = useDictionary();
  const t = dict.app.tasks.form;
  const priorityLabels = dict.app.tasks.priority;
  const isEdit = !!task;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState<string>("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [dueDate, setDueDate] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setTitle(task?.title ?? "");
    setDescription(task?.description ?? "");
    setAssigneeId(task?.assignedToUserId ?? "");
    setPriority(task?.priority ?? "normal");
    setDueDate(
      task?.dueDate
        ? new Date(task.dueDate.getTime() - task.dueDate.getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16)
        : "",
    );
  }, [isOpen, task]);

  const submit = async () => {
    if (!title.trim()) {
      onError(t.errors.titleRequired);
      return;
    }
    if (!assigneeId) {
      onError(t.errors.assigneeRequired);
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        assignedToUserId: assigneeId,
        priority,
        dueDate: dueDate ? new Date(dueDate).toISOString() : null,
      };
      const url = isEdit ? `/api/tasks/${task!.id}` : "/api/tasks";
      const method = isEdit ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        onError(json.error || t.errors.saveFailed);
        return;
      }
      await onSaved();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? t.editTitle : t.createTitle}
    >
      <div className="space-y-4">
        <Input
          label={t.titleLabel}
          placeholder={t.titlePlaceholder}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            {t.descriptionLabel}
          </label>
          <textarea
            dir="auto"
            rows={3}
            placeholder={t.descriptionPlaceholder}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg border border-border bg-white text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
          />
        </div>

        <Select
          label={t.assigneeLabel}
          options={members.map((m) => ({
            value: m.userId,
            label: `${m.displayName}${m.role === "owner" ? t.ownerSuffix : ""}`,
          }))}
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
          placeholder={t.assigneePlaceholder}
        />

        <div className="grid grid-cols-2 gap-3">
          <Select
            label={t.priorityLabel}
            options={PRIORITY_KEYS.map((p) => ({ value: p, label: priorityLabels[p] }))}
            value={priority}
            onChange={(e) => setPriority(e.target.value as TaskPriority)}
          />
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              {t.dueDateLabel}
            </label>
            <input
              type="datetime-local"
              dir="ltr"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-border bg-white text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
        </div>

        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t.cancel}
          </Button>
          <Button onClick={submit} loading={submitting}>
            {isEdit ? (
              <>
                <Save className="w-4 h-4 me-1" />
                {t.save}
              </>
            ) : (
              <>
                <Plus className="w-4 h-4 me-1" />
                {t.create}
              </>
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
