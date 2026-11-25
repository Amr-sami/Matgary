/**
 * Shared argument-parsing helpers for tool handlers.
 *
 * Models call tools with loosely-typed JSON. These helpers coerce + clamp
 * so a bad arg becomes a safe default, not an exception.
 */

import { DEFAULT_REPORTING_TZ, resolvePreset } from "@/lib/finance/dates";

export type Period = "today" | "yesterday" | "week" | "month" | "quarter" | "year" | "all";

export function windowFor(period: Period): { from: Date; to: Date } | null {
  if (period === "all") return null;
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const start = new Date(now);
  switch (period) {
    case "today":
      start.setHours(0, 0, 0, 0);
      break;
    case "yesterday": {
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() - 1);
      end.setHours(23, 59, 59, 999);
      break;
    }
    case "week":
      start.setDate(start.getDate() - 7);
      start.setHours(0, 0, 0, 0);
      break;
    case "month":
      start.setDate(start.getDate() - 30);
      start.setHours(0, 0, 0, 0);
      break;
    case "quarter":
      start.setDate(start.getDate() - 90);
      start.setHours(0, 0, 0, 0);
      break;
    case "year":
      start.setDate(start.getDate() - 365);
      start.setHours(0, 0, 0, 0);
      break;
  }
  return { from: start, to: end };
}

export function parsePeriod(v: unknown): Period {
  return v === "today" ||
    v === "yesterday" ||
    v === "week" ||
    v === "month" ||
    v === "quarter" ||
    v === "year" ||
    v === "all"
    ? v
    : "month";
}

export function parseLimit(v: unknown, def: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

export function parseBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

export function parseIsoDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** JSON-schema snippet for a period argument — reused across tools. */
export const PERIOD_ENUM = [
  "today",
  "yesterday",
  "week",
  "month",
  "quarter",
  "year",
  "all",
] as const;

export const PERIOD_SCHEMA = {
  type: "string",
  enum: PERIOD_ENUM,
  description: "today | yesterday | week (last 7d) | month (last 30d) | quarter (last 90d) | year (last 365d) | all (lifetime).",
};

/**
 * JSON-schema fragments for the paired (from, to) custom-range params. When
 * both are provided they override `period`. Format: calendar day 'YYYY-MM-DD'
 * in the tenant reporting timezone. `to` is INCLUSIVE — day boundaries are
 * resolved via `resolvePreset("custom", ...)` so the window matches the
 * Financials engine exactly.
 */
export const DATE_FROM_SCHEMA = {
  type: "string",
  description:
    "Custom range start, calendar day 'YYYY-MM-DD' (tenant reporting timezone). Pair with `to` to override `period`.",
};

export const DATE_TO_SCHEMA = {
  type: "string",
  description:
    "Custom range end (INCLUSIVE), calendar day 'YYYY-MM-DD' (tenant reporting timezone). Pair with `from`.",
};

export type ResolvedWindow =
  | { kind: "preset"; period: Period; window: { from: Date; to: Date } | null }
  | { kind: "custom"; period: "custom"; window: { from: Date; to: Date } };

/**
 * Resolve either {from,to} (ISO yyyy-mm-dd) OR {period} into a concrete
 * [from, to) window. Custom ranges go through the Financials date engine
 * (`lib/finance/dates.resolvePreset("custom", ...)`) so the boundaries match
 * `/api/financials/*` exactly, including tenant reporting timezone handling.
 *
 * Resolution precedence:
 *   1. If BOTH `from` and `to` are ISO date strings → custom window.
 *   2. Else parse `period` enum via `parsePeriod` and use `windowFor`.
 *      `all` → window = null (lifetime).
 */
export function resolveWindow(args: Record<string, unknown>): ResolvedWindow {
  const fromRaw = args.from;
  const toRaw = args.to;
  if (typeof fromRaw === "string" && typeof toRaw === "string") {
    // resolvePreset("custom", ...) returns a half-open [from, to) with `to`
    // being the day AFTER the last calendar day the user named. windowFor
    // (the preset path) returns a day-inclusive `to` (23:59:59.999). Both
    // shapes are inclusive of the user's intent — downstream queries use
    // `<=` on `to`, and both shapes satisfy that.
    const { from, to } = resolvePreset("custom", {
      tz: DEFAULT_REPORTING_TZ,
      customFrom: fromRaw,
      customTo: toRaw,
    });
    return { kind: "custom", period: "custom", window: { from, to } };
  }
  const period = parsePeriod(args.period);
  return { kind: "preset", period, window: windowFor(period) };
}
