// Deterministic natural-language date parser for AI tools (task due dates,
// future reminder dates, etc.). Parses a small, safe subset:
//
//   • "today" / "tomorrow"
//   • weekday names ("monday", "fri", "جمعة") → next occurrence of that weekday
//   • "next <weekday>" → always +7 from the next occurrence
//   • "next week" → +7 days from today
//   • "YYYY-MM-DD" → that date verbatim
//
// Anything else returns null — the Agent then asks the user instead of
// guessing. All calculations happen in the tenant's reporting timezone so a
// task "due Friday" lands on the shop's Friday, not UTC's.

import { DEFAULT_REPORTING_TZ } from "@/lib/finance/dates";

export interface NaturalDateResult {
  /** The parsed calendar day as 'YYYY-MM-DD' in the tenant's reporting TZ. */
  isoDay: string;
  /** Short label the Agent can echo back so the user can catch mis-parses. */
  label: string;
}

const WEEKDAYS: Record<string, number> = {
  // English long + short
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
  // Arabic
  "الأحد": 0, "الاحد": 0,
  "الاثنين": 1, "الإثنين": 1,
  "الثلاثاء": 2,
  "الأربعاء": 3, "الاربعاء": 3,
  "الخميس": 4,
  "الجمعة": 5,
  "السبت": 6,
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Return 'YYYY-MM-DD' in the given IANA timezone. */
function ymdInTz(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${day}`;
}

/** Weekday index (0=Sun … 6=Sat) of a Date in a given TZ. */
function weekdayInTz(d: Date, tz: string): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).format(d);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[name as "Sun"]!;
}

function addDays(iso: string, days: number): string {
  // Safe because YYYY-MM-DD parses to UTC midnight; adding whole days can't
  // shift across DST boundaries in a way that changes the calendar day.
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function parseNaturalDate(
  input: string | null | undefined,
  now: Date = new Date(),
  tz: string = DEFAULT_REPORTING_TZ,
): NaturalDateResult | null {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  // Direct ISO day
  if (ISO_DAY.test(raw)) return { isoDay: raw, label: raw };

  const today = ymdInTz(now, tz);
  const normalized = raw.toLowerCase();

  if (normalized === "today" || normalized === "اليوم") {
    return { isoDay: today, label: "today" };
  }
  if (normalized === "tomorrow" || normalized === "غدا" || normalized === "غدًا" || normalized === "بكرة") {
    const iso = addDays(today, 1);
    return { isoDay: iso, label: "tomorrow" };
  }
  if (normalized === "next week" || normalized === "الأسبوع القادم" || normalized === "الاسبوع القادم") {
    const iso = addDays(today, 7);
    return { isoDay: iso, label: "next week" };
  }

  // "next <weekday>" — always skip forward at least 7 days from today.
  const nextWeekdayMatch = /^next\s+([a-z]+)$/.exec(normalized);
  const target = nextWeekdayMatch ? nextWeekdayMatch[1] : normalized;
  if (target in WEEKDAYS) {
    const targetIdx = WEEKDAYS[target];
    const todayIdx = weekdayInTz(now, tz);
    let delta = (targetIdx - todayIdx + 7) % 7;
    if (delta === 0) delta = 7; // today's weekday → next week's same weekday
    if (nextWeekdayMatch) {
      // "next friday" explicitly means the one that comes AFTER this week's
      // friday. If today is Monday and the user says "next friday", they
      // usually mean the Friday of the following week — add 7 more.
      if (delta <= 7) delta += 7 - (delta === 7 ? 7 : 0);
    }
    return {
      isoDay: addDays(today, delta),
      label: nextWeekdayMatch ? `next ${target}` : target,
    };
  }

  return null;
}
