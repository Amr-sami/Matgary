// Slice 1 — period helpers.
//
// Periods arrive on the wire as either a named preset ('today', 'this_month',
// …) or a custom {from, to} pair. The engine always takes a half-open
// instant pair; this module is where calendar semantics (timezone, month
// boundaries) turn into instants.
//
// The owner's reporting timezone is the tenant's `timezone` column. Where a
// caller hasn't resolved that yet, we fall back to the deployment-wide
// `STORO_REPORTING_TZ` (same env var the admin/presence module uses) and
// finally to Africa/Cairo.

import type { FinancePeriod } from "./types";

export type DatePresetKey =
  | "today"
  | "yesterday"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month"
  | "this_year"
  | "last_7_days"
  | "last_30_days"
  | "custom";

export function isDatePresetKey(v: unknown): v is DatePresetKey {
  return (
    v === "today" ||
    v === "yesterday" ||
    v === "this_week" ||
    v === "last_week" ||
    v === "this_month" ||
    v === "last_month" ||
    v === "this_year" ||
    v === "last_7_days" ||
    v === "last_30_days" ||
    v === "custom"
  );
}

export const DEFAULT_REPORTING_TZ =
  process.env.STORO_REPORTING_TZ && process.env.STORO_REPORTING_TZ.trim() !== ""
    ? process.env.STORO_REPORTING_TZ
    : "Africa/Cairo";

/** `now` in ms resolution. Extracted so tests can inject a deterministic clock. */
export interface Clock {
  now(): Date;
}

export const SYSTEM_CLOCK: Clock = {
  now: () => new Date(),
};

/**
 * Format `Date` as "YYYY-MM-DD HH:mm:ss" in the given timezone using
 * `Intl.DateTimeFormat`. Node's built-in Intl is always available in Vitest +
 * production bundle, so no polyfill needed.
 */
function wallClockParts(d: Date, tz: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0..6, 0 = Sun (JS convention)
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour === "24" ? "00" : map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: weekdayMap[map.weekday] ?? 0,
  };
}

/** Return the UTC instant that corresponds to wall-clock `(y/m/d h:mm:ss)`
 *  in `tz`. The trick: construct a UTC Date for those components, read its
 *  own wall clock in `tz` and compute the offset, then shift. */
function wallClockToInstant(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  s: number,
  tz: string,
): Date {
  // First pass: assume no DST transition. The wall clock in tz for the
  // instant we build may differ by exactly the local offset at that time.
  const utc = Date.UTC(y, m - 1, d, h, min, s, 0);
  const parts = wallClockParts(new Date(utc), tz);
  const wallGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const offsetMs = wallGuess - utc; // positive if tz is east of UTC
  return new Date(utc - offsetMs);
}

/** Start-of-day instant for the (year/month/day) wall clock in `tz`. */
function startOfDay(y: number, m: number, d: number, tz: string): Date {
  return wallClockToInstant(y, m, d, 0, 0, 0, tz);
}

/** `yyyy-mm-dd` → half-open [00:00, 24:00) instants in `tz`. */
export function dayRange(ymd: string, tz: string = DEFAULT_REPORTING_TZ): FinancePeriod {
  const [y, m, d] = ymd.split("-").map((n) => Number(n));
  const from = startOfDay(y, m, d, tz);
  const next = new Date(from.getTime());
  // Add 24h and let the DST-safe helper recover the correct wall clock.
  const d2 = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  const p2 = wallClockParts(d2, tz);
  const to = startOfDay(p2.year, p2.month, p2.day, tz);
  void next;
  return { from, to };
}

/** Resolve a preset into a half-open [from, to) pair in the reporting timezone. */
export function resolvePreset(
  preset: DatePresetKey,
  opts: { clock?: Clock; tz?: string; customFrom?: string; customTo?: string } = {},
): FinancePeriod {
  const tz = opts.tz ?? DEFAULT_REPORTING_TZ;
  const now = (opts.clock ?? SYSTEM_CLOCK).now();
  const today = wallClockParts(now, tz);

  const todayStart = startOfDay(today.year, today.month, today.day, tz);

  switch (preset) {
    case "today":
      return dayRange(ymd(today.year, today.month, today.day), tz);
    case "yesterday": {
      const yday = addDays(today.year, today.month, today.day, -1, tz);
      return dayRange(ymd(yday.year, yday.month, yday.day), tz);
    }
    case "this_week": {
      // Week starts on Sunday — matches the mobile dashboard chip row.
      const dow = today.weekday; // 0 = Sun
      const start = addDays(today.year, today.month, today.day, -dow, tz);
      const nextStart = addDays(start.year, start.month, start.day, 7, tz);
      return {
        from: startOfDay(start.year, start.month, start.day, tz),
        to: startOfDay(nextStart.year, nextStart.month, nextStart.day, tz),
      };
    }
    case "last_week": {
      const dow = today.weekday;
      const thisWeekStart = addDays(today.year, today.month, today.day, -dow, tz);
      const lastWeekStart = addDays(
        thisWeekStart.year,
        thisWeekStart.month,
        thisWeekStart.day,
        -7,
        tz,
      );
      return {
        from: startOfDay(
          lastWeekStart.year,
          lastWeekStart.month,
          lastWeekStart.day,
          tz,
        ),
        to: startOfDay(
          thisWeekStart.year,
          thisWeekStart.month,
          thisWeekStart.day,
          tz,
        ),
      };
    }
    case "this_month": {
      const from = startOfDay(today.year, today.month, 1, tz);
      const nextMonth = today.month === 12 ? { y: today.year + 1, m: 1 } : { y: today.year, m: today.month + 1 };
      const to = startOfDay(nextMonth.y, nextMonth.m, 1, tz);
      return { from, to };
    }
    case "last_month": {
      const prev = today.month === 1 ? { y: today.year - 1, m: 12 } : { y: today.year, m: today.month - 1 };
      const from = startOfDay(prev.y, prev.m, 1, tz);
      const to = startOfDay(today.year, today.month, 1, tz);
      return { from, to };
    }
    case "this_year": {
      const from = startOfDay(today.year, 1, 1, tz);
      const to = startOfDay(today.year + 1, 1, 1, tz);
      return { from, to };
    }
    case "last_7_days": {
      const from = addDaysInstant(todayStart, -7);
      const to = addDaysInstant(todayStart, 1); // through end of today
      return { from, to };
    }
    case "last_30_days": {
      const from = addDaysInstant(todayStart, -30);
      const to = addDaysInstant(todayStart, 1);
      return { from, to };
    }
    case "custom": {
      if (!opts.customFrom || !opts.customTo) {
        // Guard: a malformed custom range collapses to "today" instead of
        // returning a NaN-tainted period. Caller should validate at the API.
        return dayRange(ymd(today.year, today.month, today.day), tz);
      }
      const from = parseYmd(opts.customFrom, tz);
      const toExclusive = parseYmd(opts.customTo, tz);
      // `customTo` is treated INCLUSIVELY — shift by one day so the half-open
      // period actually covers the last day end-to-end.
      const toParts = addDaysInstant(toExclusive, 1);
      return { from, to: toParts };
    }
  }
}

function ymd(y: number, m: number, d: number): string {
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

function parseYmd(s: string, tz: string): Date {
  const [y, m, d] = s.split("-").map((n) => Number(n));
  return startOfDay(y, m, d, tz);
}

function addDays(
  y: number,
  m: number,
  d: number,
  deltaDays: number,
  tz: string,
): { year: number; month: number; day: number } {
  const base = startOfDay(y, m, d, tz);
  const shifted = new Date(base.getTime() + deltaDays * 24 * 60 * 60 * 1000);
  const parts = wallClockParts(shifted, tz);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function addDaysInstant(instant: Date, deltaDays: number): Date {
  return new Date(instant.getTime() + deltaDays * 24 * 60 * 60 * 1000);
}
