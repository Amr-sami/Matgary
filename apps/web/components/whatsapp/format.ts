// Time-ago + window-countdown formatters for the inbox.
//
// Both formatters take their localised copy from the dictionary so callers
// can stay locale-aware. Callers pass `locale` (for the absolute-date fallback)
// and the relevant copy bundle (relative or window).

import type { Locale } from "@/lib/i18n/config";
import { formatDate, formatTime } from "@/lib/i18n/format";

export interface RelativeCopy {
  now: string;
  minutes: string;
  hours: string;
  days: string;
}

export function relativeTime(
  iso: string | null | undefined,
  locale: Locale,
  copy: RelativeCopy,
): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.valueOf())) return "";
  const diffMs = Date.now() - d.getTime();
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return copy.now;
  if (min < 60) return copy.minutes.replace("{n}", String(min));
  const h = Math.round(min / 60);
  if (h < 24) return copy.hours.replace("{n}", String(h));
  const days = Math.round(h / 24);
  if (days < 7) return copy.days.replace("{n}", String(days));
  return formatDate(d, locale);
}

export function clockTime(
  iso: string | null | undefined,
  locale: Locale,
): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.valueOf())) return "";
  return formatTime(d, locale);
}

export interface WindowCopy {
  noChat: string;
  closed: string;
  endingSoon: string;
  /** `"النافذة مفتوحة ({h} ساعة متبقية)"` */
  openHours: string;
}

export interface WindowDisplay {
  label: string;
  tone: "open" | "warning" | "closed";
}

export function windowDisplay(
  expiresAt: string | null | undefined,
  copy: WindowCopy,
): WindowDisplay {
  if (!expiresAt) {
    return { label: copy.noChat, tone: "closed" };
  }
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) {
    return { label: copy.closed, tone: "closed" };
  }
  const h = Math.round(ms / 3_600_000);
  if (h <= 1) {
    return { label: copy.endingSoon, tone: "warning" };
  }
  return {
    label: copy.openHours.replace("{h}", String(h)),
    tone: "open",
  };
}
