"use client";

/**
 * Manager-side monthly attendance view.
 *
 * Shows one row per employee for the selected month with rolled-up totals
 * (days worked, regular / weekend hours, expected hours, review flags), a
 * month picker to move backward/forward, and a one-click CSV export that
 * Excel opens correctly in Arabic. Clicking an employee row expands to a
 * per-shift breakdown with check-in/check-out times and hours.
 *
 * Data flows from /api/attendance/monthly?month=YYYY-MM (see route.ts).
 * Sits under the today-roster inside the Attendance tab and shares the
 * roster's toast channel so error surfacing is consistent.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Download,
  AlertCircle,
  Check,
  XCircle,
  Clock,
} from "@/lib/icons";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import {
  useDictionary,
  useLocale,
} from "@/components/i18n/DictionaryProvider";

type Toast = { type: "success" | "error"; message: string };

interface MonthlyShift {
  date: string;
  dayOfWeek: number;
  isWeekend: boolean;
  checkInAt: string;
  checkOutAt: string | null;
  hours: number;
  requiresReview: boolean;
  checkInSource: string;
  checkOutSource: string | null;
  note: string | null;
}

interface MonthlyEmployee {
  userId: string;
  displayName: string;
  username: string;
  totals: {
    shifts: number;
    hoursTotal: number;
    regularHours: number;
    weekendHours: number;
    daysWorked: number;
    reviewCount: number;
    expectedHours: number;
  };
  shifts: MonthlyShift[];
}

interface MonthlyPayload {
  month: string;
  startsAt: string;
  endsAt: string;
  workingDaysInMonth: number;
  settings: { workHoursPerDay: number; weekendDays: number[] };
  employees: MonthlyEmployee[];
}

interface Props {
  onToast: (t: Toast) => void;
}

export function MonthlyAttendance({ onToast }: Props) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.team.monthly;
  const [month, setMonth] = useState<string>(currentMonthYYYYMM());
  const [data, setData] = useState<MonthlyPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const isCurrentMonth = month === currentMonthYYYYMM();

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/attendance/monthly?month=${month}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        if (res.status === 403) {
          setData(null);
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as MonthlyPayload;
      setData(json);
      setExpanded(new Set());
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
  }, [month]);

  const monthLabel = useMemo(
    () => formatMonthLabel(month, locale),
    [month, locale],
  );

  const goPrev = () => setMonth(shiftMonth(month, -1));
  const goNext = () => {
    if (isCurrentMonth) return;
    setMonth(shiftMonth(month, +1));
  };
  const goCurrent = () => setMonth(currentMonthYYYYMM());

  const toggleExpand = (userId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const downloadCsv = () => {
    // Triggering a plain <a> click keeps the browser's own download UI
    // instead of blobs → filename is derived from Content-Disposition.
    const a = document.createElement("a");
    a.href = `/api/attendance/monthly/export?month=${month}&locale=${locale}`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="bg-white rounded-xl border border-border overflow-hidden">
      {/* Header — month navigator + CSV download */}
      <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Calendar className="w-5 h-5 text-accent" />
          <h3 className="font-bold text-base">{t.heading}</h3>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-main">
            <button
              type="button"
              onClick={goPrev}
              className="p-1.5 hover:bg-white rounded-s-lg text-text-secondary hover:text-text-primary transition-colors"
              aria-label={t.prevMonth}
              title={t.prevMonth}
            >
              <ChevronRight className="w-4 h-4 rtl:hidden" />
              <ChevronLeft className="w-4 h-4 ltr:hidden" />
            </button>
            <span className="px-3 py-1.5 text-sm font-medium min-w-[8ch] text-center">
              {monthLabel}
            </span>
            <button
              type="button"
              onClick={goNext}
              disabled={isCurrentMonth}
              className="p-1.5 hover:bg-white rounded-e-lg text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
              aria-label={t.nextMonth}
              title={t.nextMonth}
            >
              <ChevronLeft className="w-4 h-4 rtl:hidden" />
              <ChevronRight className="w-4 h-4 ltr:hidden" />
            </button>
          </div>
          {!isCurrentMonth && (
            <button
              type="button"
              onClick={goCurrent}
              className="text-xs text-accent hover:underline"
            >
              {t.thisMonth}
            </button>
          )}
          <Button
            variant="secondary"
            onClick={downloadCsv}
            disabled={loading || !data || data.employees.length === 0}
            className="px-3 py-1.5 text-xs gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            {t.downloadCsv}
          </Button>
        </div>
      </div>

      {/* Working-days summary strip */}
      {data && !loading && (
        <div className="px-5 py-2.5 bg-bg-main/40 border-b border-border text-xs text-text-secondary flex items-center gap-4 flex-wrap">
          <span>
            {t.workingDays.replace(
              "{n}",
              String(data.workingDaysInMonth),
            )}
          </span>
          <span>
            {t.expectedPerEmployee.replace(
              "{n}",
              String(data.workingDaysInMonth * data.settings.workHoursPerDay),
            )}
          </span>
        </div>
      )}

      {/* Body */}
      {loading ? (
        <div className="p-8 text-center text-text-secondary">{t.loading}</div>
      ) : !data || data.employees.length === 0 ? (
        <div className="p-8 text-center">
          <Clock className="w-8 h-8 text-text-secondary mx-auto mb-2" />
          <p className="text-text-secondary text-sm">{t.empty}</p>
        </div>
      ) : (
        <ul>
          {data.employees.map((emp) => (
            <EmployeeRow
              key={emp.userId}
              employee={emp}
              expanded={expanded.has(emp.userId)}
              onToggle={() => toggleExpand(emp.userId)}
              t={t}
              locale={locale}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// One employee row + optional day-by-day drill-down
// ─────────────────────────────────────────────────────────────────────────────

function EmployeeRow({
  employee,
  expanded,
  onToggle,
  t,
  locale,
}: {
  employee: MonthlyEmployee;
  expanded: boolean;
  onToggle: () => void;
  t: MonthlyStrings;
  locale: "ar" | "en";
}) {
  const { displayName, totals, shifts } = employee;
  const isBelowExpected =
    totals.expectedHours > 0 && totals.hoursTotal < totals.expectedHours;

  return (
    <li className="border-b border-border last:border-0">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "w-full flex items-center justify-between gap-3 px-5 py-3 text-start transition-colors",
          expanded ? "bg-accent-light/40" : "hover:bg-bg-main/50",
        )}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="shrink-0 w-9 h-9 rounded-full bg-accent-light text-accent font-bold text-sm flex items-center justify-center">
            {displayName.charAt(0)}
          </span>
          <div className="min-w-0">
            <p
              className="font-medium text-text-primary truncate flex items-center gap-1.5"
              dir="auto"
            >
              {displayName}
              {totals.reviewCount > 0 && (
                <AlertCircle
                  className="w-3.5 h-3.5 text-warning"
                  weight="fill"
                />
              )}
            </p>
            <p className="text-xs text-text-secondary mt-0.5">
              {t.rowSubline
                .replace("{days}", String(totals.daysWorked))
                .replace("{shifts}", String(totals.shifts))}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <MetricCell
            label={t.metric.total}
            value={formatHours(totals.hoursTotal, locale)}
            tone={
              isBelowExpected
                ? "warn"
                : totals.hoursTotal > 0
                  ? "success"
                  : "muted"
            }
          />
          <MetricCell
            label={t.metric.regular}
            value={formatHours(totals.regularHours, locale)}
          />
          <MetricCell
            label={t.metric.weekend}
            value={formatHours(totals.weekendHours, locale)}
          />
          <MetricCell
            label={t.metric.expected}
            value={formatHours(totals.expectedHours, locale)}
            tone="muted"
          />
        </div>
      </button>

      {expanded && (
        <div className="px-5 pb-4 pt-1 bg-bg-main/30">
          {shifts.length === 0 ? (
            <p className="text-sm text-text-secondary text-center py-6">
              {t.noShifts}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border bg-white">
              <table className="w-full text-sm">
                <thead className="bg-bg-main/60 text-xs text-text-secondary">
                  <tr>
                    <th className="text-start px-3 py-2 font-medium">
                      {t.table.date}
                    </th>
                    <th className="text-start px-3 py-2 font-medium">
                      {t.table.day}
                    </th>
                    <th className="text-start px-3 py-2 font-medium">
                      {t.table.checkIn}
                    </th>
                    <th className="text-start px-3 py-2 font-medium">
                      {t.table.checkOut}
                    </th>
                    <th className="text-end px-3 py-2 font-medium">
                      {t.table.hours}
                    </th>
                    <th className="text-start px-3 py-2 font-medium">
                      {t.table.status}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shifts.map((s, i) => (
                    <tr
                      key={`${s.date}-${s.checkInAt}-${i}`}
                      className={cn(
                        "border-t border-border",
                        s.isWeekend && "bg-warning/5",
                      )}
                    >
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatDayNumber(s.date, locale)}
                      </td>
                      <td className="px-3 py-2 text-text-secondary whitespace-nowrap">
                        {DAY_NAMES[locale][s.dayOfWeek]}
                        {s.isWeekend && (
                          <span className="ms-1 text-warning">·</span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          <Check className="w-3.5 h-3.5 text-success" />
                          {formatTimeHm(s.checkInAt, locale)}
                        </span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {s.checkOutAt ? (
                          <span className="inline-flex items-center gap-1">
                            <XCircle className="w-3.5 h-3.5 text-text-secondary" />
                            {formatTimeHm(s.checkOutAt, locale)}
                          </span>
                        ) : (
                          <span className="text-warning font-medium">
                            {t.table.open}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-end tabular-nums whitespace-nowrap">
                        {s.checkOutAt ? formatHours(s.hours, locale) : "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {s.requiresReview ? (
                          <span className="inline-flex items-center gap-1 text-warning text-xs font-medium">
                            <AlertCircle className="w-3.5 h-3.5" weight="fill" />
                            {t.table.review}
                          </span>
                        ) : (
                          <span className="text-text-secondary text-xs">
                            {s.isWeekend ? t.table.weekend : t.table.regular}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function MetricCell({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "muted" | "warn" | "success";
}) {
  const valueCls =
    tone === "warn"
      ? "text-warning"
      : tone === "success"
        ? "text-success"
        : tone === "muted"
          ? "text-text-secondary"
          : "text-text-primary";
  return (
    <div className="text-end min-w-[5.5rem] hidden sm:block">
      <p className={cn("text-sm font-semibold tabular-nums", valueCls)}>
        {value}
      </p>
      <p className="text-[10px] text-text-secondary uppercase tracking-wide">
        {label}
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers — dates, month math, formatting
// ─────────────────────────────────────────────────────────────────────────────

type MonthlyStrings = ReturnType<typeof useDictionary>["app"]["team"]["monthly"];

function currentMonthYYYYMM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(yyyyMm: string, delta: number): string {
  const [ys, ms] = yyyyMm.split("-");
  const d = new Date(Number(ys), Number(ms) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(yyyyMm: string, locale: "ar" | "en"): string {
  const [ys, ms] = yyyyMm.split("-");
  const d = new Date(Number(ys), Number(ms) - 1, 1);
  return new Intl.DateTimeFormat(locale === "en" ? "en-EG" : "ar-EG", {
    year: "numeric",
    month: "long",
    numberingSystem: "latn",
  } as Intl.DateTimeFormatOptions).format(d);
}

function formatDayNumber(dateKey: string, locale: "ar" | "en"): string {
  const d = new Date(dateKey);
  return new Intl.DateTimeFormat(locale === "en" ? "en-EG" : "ar-EG", {
    day: "numeric",
    month: "short",
    numberingSystem: "latn",
  } as Intl.DateTimeFormatOptions).format(d);
}

function formatTimeHm(iso: string, locale: "ar" | "en"): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(locale === "en" ? "en-EG" : "ar-EG", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    numberingSystem: "latn",
  } as Intl.DateTimeFormatOptions).format(d);
}

function formatHours(n: number, locale: "ar" | "en"): string {
  const formatted = new Intl.NumberFormat(
    locale === "en" ? "en-EG" : "ar-EG",
    {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
      numberingSystem: "latn",
    } as Intl.NumberFormatOptions,
  ).format(n);
  return `${formatted}h`;
}

const DAY_NAMES: Record<"ar" | "en", readonly string[]> = {
  ar: [
    "الأحد",
    "الاثنين",
    "الثلاثاء",
    "الأربعاء",
    "الخميس",
    "الجمعة",
    "السبت",
  ],
  en: [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ],
} as const;
