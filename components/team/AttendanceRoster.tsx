"use client";

import { useEffect, useState } from "react";
import {
  Clock,
  Check,
  XCircle,
  AlertCircle,
  Pencil,
  Trash2,
  RotateCcw,
} from "@/lib/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/utils";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatTime } from "@/lib/i18n/format";

type Toast = { type: "success" | "error"; message: string };

type RosterStatus = "checked_in" | "checked_out" | "absent";

interface RosterEvent {
  id: string;
  type: "check_in" | "check_out";
  occurredAt: string;
  source: string;
  note: string | null;
  requiresReview: boolean;
}

interface RosterRow {
  userId: string;
  username: string;
  displayName: string;
  status: RosterStatus;
  lastEvent: RosterEvent | null;
}

interface DayEvent extends RosterEvent {
  // recordedByUserId is also returned but we don't display it directly.
}

interface Props {
  onToast: (t: Toast) => void;
}

export function AttendanceRoster({ onToast }: Props) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.team.roster;
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openEmployee, setOpenEmployee] = useState<RosterRow | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/attendance/today", { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 403) {
          setRoster([]);
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await res.json();
      setRoster(json.roster);
    } catch (e) {
      onToast({
        type: "error",
        message: e instanceof Error ? e.message : t.loadFailed,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recordEvent = async (
    member: RosterRow,
    type: "check_in" | "check_out",
  ) => {
    setBusyId(member.userId);
    try {
      const res = await fetch("/api/attendance/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId: member.userId,
          type,
          source: "manager_attest",
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        onToast({ type: "error", message: json.error || t.toast.saveFailed });
        return;
      }
      onToast({
        type: "success",
        message: type === "check_in" ? t.toast.checkedIn : t.toast.checkedOut,
      });
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-border p-8 text-center text-text-secondary">
        {t.loading}
      </div>
    );
  }

  if (roster.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-border p-8 text-center">
        <Clock className="w-8 h-8 text-text-secondary mx-auto mb-2" />
        <p className="text-text-secondary text-sm">
          {t.empty}
        </p>
      </div>
    );
  }

  const inCount = roster.filter((r) => r.status === "checked_in").length;
  const outCount = roster.filter((r) => r.status === "checked_out").length;
  const absentCount = roster.filter((r) => r.status === "absent").length;
  const reviewCount = roster.filter(
    (r) => r.lastEvent?.requiresReview,
  ).length;

  const todayLabel = new Date().toLocaleDateString(
    locale === "en" ? "en-EG" : "ar-EG",
    {
      weekday: "long",
      day: "numeric",
      month: "long",
      numberingSystem: "latn",
    } as Intl.DateTimeFormatOptions,
  );

  const renderStatusLabel = (r: RosterRow) => {
    if (!r.lastEvent) return t.status.notYet;
    const at = formatTime(r.lastEvent.occurredAt, locale);
    return r.status === "checked_in"
      ? t.status.checkedInAt.replace("{time}", at)
      : t.status.checkedOutAt.replace("{time}", at);
  };

  return (
    <>
      <div className="bg-white rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-accent" />
            <h3 className="font-bold text-base">{t.todayHeading}</h3>
            <span className="text-xs text-text-secondary">
              {todayLabel}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <Pill color="success" label={t.pill.present.replace("{n}", String(inCount))} />
            <Pill color="muted" label={t.pill.out.replace("{n}", String(outCount))} />
            <Pill color="muted" label={t.pill.absent.replace("{n}", String(absentCount))} />
            {reviewCount > 0 && (
              <Pill color="warn" label={t.pill.review.replace("{n}", String(reviewCount))} />
            )}
          </div>
        </div>

        <ul>
          {roster.map((m) => (
            <li
              key={m.userId}
              className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border last:border-0"
            >
              <button
                type="button"
                onClick={() => setOpenEmployee(m)}
                className="flex items-center gap-3 min-w-0 text-start hover:opacity-80"
              >
                <span className="shrink-0 w-9 h-9 rounded-full bg-accent-light text-accent font-bold text-sm flex items-center justify-center">
                  {m.displayName.charAt(0)}
                </span>
                <div className="min-w-0">
                  <p className="font-medium text-text-primary truncate flex items-center gap-1.5" dir="auto">
                    {m.displayName}
                    {m.lastEvent?.requiresReview && (
                      <AlertCircle
                        className="w-3.5 h-3.5 text-warning"
                        weight="fill"
                      />
                    )}
                  </p>
                  <p className="text-xs text-text-secondary truncate">
                    {renderStatusLabel(m)}
                  </p>
                </div>
              </button>

              <div className="flex items-center gap-2 shrink-0">
                {m.status === "checked_in" ? (
                  <Button
                    variant="secondary"
                    onClick={() => recordEvent(m, "check_out")}
                    loading={busyId === m.userId}
                    disabled={busyId === m.userId}
                    className="px-3 py-1.5 text-xs gap-1.5"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    {t.action.checkOut}
                  </Button>
                ) : (
                  <Button
                    onClick={() => recordEvent(m, "check_in")}
                    loading={busyId === m.userId}
                    disabled={busyId === m.userId}
                    className="px-3 py-1.5 text-xs gap-1.5"
                  >
                    <Check className="w-3.5 h-3.5" />
                    {t.action.checkIn}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {openEmployee && (
        <DayEventsModal
          member={openEmployee}
          onClose={() => setOpenEmployee(null)}
          onRefresh={refresh}
          onToast={onToast}
        />
      )}
    </>
  );
}

function Pill({
  color,
  label,
}: {
  color: "success" | "muted" | "warn";
  label: string;
}) {
  const cls =
    color === "success"
      ? "bg-success/10 text-success"
      : color === "warn"
        ? "bg-warning/10 text-warning"
        : "bg-bg-main text-text-secondary";
  return (
    <span className={cn("px-2 py-1 rounded-full font-medium", cls)}>
      {label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Day events modal — shows the full day's events for one employee with edit/delete
// ─────────────────────────────────────────────────────────────────────────────

function DayEventsModal({
  member,
  onClose,
  onRefresh,
  onToast,
}: {
  member: RosterRow;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onToast: (t: Toast) => void;
}) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.team.dayEvents;
  const [events, setEvents] = useState<DayEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<DayEvent | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const today = new Date();
      const start = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
      ).toISOString();
      const end = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
        23,
        59,
        59,
        999,
      ).toISOString();
      const res = await fetch(
        `/api/attendance/events?employeeId=${member.userId}&from=${start}&to=${end}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setEvents(json.events);
    } catch (e) {
      onToast({
        type: "error",
        message: e instanceof Error ? e.message : t.toast.loadFailed,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeEvent = async (id: string) => {
    const res = await fetch(`/api/attendance/events/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      onToast({ type: "error", message: t.toast.deleteFailed });
      return;
    }
    await load();
    await onRefresh();
  };

  const clearReview = async (id: string) => {
    const res = await fetch(`/api/attendance/events/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requiresReview: false }),
    });
    if (!res.ok) {
      onToast({ type: "error", message: t.toast.updateFailed });
      return;
    }
    await load();
    await onRefresh();
  };

  const sourceLabel = (s: string): string => {
    const map = t.source as Record<string, string>;
    return map[s] ?? t.source.manual;
  };

  return (
    <Modal isOpen onClose={onClose} title={t.title.replace("{name}", member.displayName)}>
      {loading ? (
        <p className="text-center text-text-secondary py-8">{t.loading}</p>
      ) : events.length === 0 ? (
        <p className="text-center text-text-secondary py-8">{t.empty}</p>
      ) : (
        <ul className="space-y-2">
          {events.map((e) => (
            <li
              key={e.id}
              className={cn(
                "flex items-center justify-between gap-3 p-3 rounded-lg border",
                e.requiresReview
                  ? "border-warning/40 bg-warning/5"
                  : "border-border bg-bg-main/40",
              )}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {e.type === "check_in" ? (
                  <Check className="w-4 h-4 text-success shrink-0" />
                ) : (
                  <XCircle className="w-4 h-4 text-text-secondary shrink-0" />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary">
                    {e.type === "check_in" ? t.event.checkIn : t.event.checkOut}{" "}
                    <span className="text-text-secondary text-xs font-normal">
                      ({sourceLabel(e.source)})
                    </span>
                  </p>
                  <p className="text-xs text-text-secondary mt-0.5">
                    {formatTime(e.occurredAt, locale)}
                    {e.requiresReview && (
                      <span className="text-warning font-medium me-2">
                        {t.event.needsReview}
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {e.requiresReview && (
                  <button
                    type="button"
                    onClick={() => clearReview(e.id)}
                    title={t.action.clearReview}
                    className="p-1.5 rounded-lg text-text-secondary hover:text-success hover:bg-success/10"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setEditing(e)}
                  title={t.action.edit}
                  className="p-1.5 rounded-lg text-text-secondary hover:text-accent hover:bg-accent-light"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => removeEvent(e.id)}
                  title={t.action.delete}
                  className="p-1.5 rounded-lg text-text-secondary hover:text-danger hover:bg-danger-light"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <EditEventForm
          event={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
            await onRefresh();
          }}
          onToast={onToast}
        />
      )}
    </Modal>
  );
}

function EditEventForm({
  event,
  onClose,
  onSaved,
  onToast,
}: {
  event: DayEvent;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onToast: (t: Toast) => void;
}) {
  const dict = useDictionary();
  const t = dict.app.team.editEvent;
  const initialTime = new Date(event.occurredAt);
  const hh = String(initialTime.getHours()).padStart(2, "0");
  const mm = String(initialTime.getMinutes()).padStart(2, "0");
  const [time, setTime] = useState(`${hh}:${mm}`);
  const [type, setType] = useState(event.type);
  const [note, setNote] = useState(event.note ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const [h, m] = time.split(":").map(Number);
      const occurredAt = new Date(event.occurredAt);
      occurredAt.setHours(h, m, 0, 0);
      const res = await fetch(`/api/attendance/events/${event.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          occurredAt: occurredAt.toISOString(),
          note: note || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        onToast({ type: "error", message: json.error || t.saveFailed });
        return;
      }
      onToast({ type: "success", message: t.saveSuccess });
      await onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={t.title}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              {t.typeLabel}
            </label>
            <select
              value={type}
              onChange={(e) =>
                setType(e.target.value as "check_in" | "check_out")
              }
              dir="auto"
              className="w-full px-3 py-2.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="check_in">{t.checkIn}</option>
              <option value="check_out">{t.checkOut}</option>
            </select>
          </div>
          <Input
            label={t.timeLabel}
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </div>
        <Input
          label={t.noteLabel}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t.notePlaceholder}
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button onClick={save} loading={busy} disabled={busy}>
            <RotateCcw className="w-4 h-4 me-1" />
            {t.save}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
