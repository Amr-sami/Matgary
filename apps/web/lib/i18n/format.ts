/**
 * Locale-aware formatters for the logged-in app.
 *
 * Per i18n-app-phase2.md §4: Latin digits everywhere (both locales). EGP
 * currency. Day-first dates (2 May 2026 / 2 مايو 2026). 24h clock.
 *
 * Built on Intl with `numberingSystem: "latn"` forced so an environment
 * default of Arabic-Indic doesn't sneak in.
 */

import type { Locale } from "./config";

function intlLocale(locale: Locale): string {
  // Egypt-anchored locale tags so months / first-day-of-week / currency
  // formatting match the user's actual region. Latin numerals forced by
  // numberingSystem below; the -EG region is purely for month names + day-
  // first ordering.
  return locale === "en" ? "en-EG" : "ar-EG";
}

const NUM_FORCE_LATIN: Intl.NumberFormatOptions = {
  numberingSystem: "latn" as Intl.NumberFormatOptions["numberingSystem"],
};

export function formatNumber(n: number, locale: Locale): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(intlLocale(locale), {
    ...NUM_FORCE_LATIN,
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatPercent(n: number, locale: Locale): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(intlLocale(locale), {
    ...NUM_FORCE_LATIN,
    style: "percent",
    maximumFractionDigits: 1,
  }).format(n);
}

/**
 * Currency with the "no decimals when whole" rule. POS-friendly:
 *   formatCurrency(2300, "en")   → "EGP 2,300"
 *   formatCurrency(2300.5, "en") → "EGP 2,300.50"
 *   formatCurrency(2300, "ar")   → "2,300 ج.م"
 *
 * EN uses Intl's currency formatting (symbol-before). AR keeps the
 * traditional Egyptian "ج.م" suffix because Intl's default in ar-EG
 * is "ج.م.‏" with embedded marks that look noisy in tabular UIs.
 */
export function formatCurrency(amount: number, locale: Locale): string {
  if (!Number.isFinite(amount)) return "—";
  const isWhole = Math.round(amount) === amount;
  const minimumFractionDigits = isWhole ? 0 : 2;
  const maximumFractionDigits = isWhole ? 0 : 2;

  if (locale === "en") {
    return new Intl.NumberFormat("en-EG", {
      ...NUM_FORCE_LATIN,
      style: "currency",
      currency: "EGP",
      currencyDisplay: "code", // "EGP 2,300" not "E£2,300"
      minimumFractionDigits,
      maximumFractionDigits,
    }).format(amount);
  }
  // AR: number then suffix, both directionally locked LTR so it doesn't
  // mirror in RTL paragraphs.
  const num = new Intl.NumberFormat("ar-EG", {
    ...NUM_FORCE_LATIN,
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(amount);
  return `${num} ج.م`;
}

/** "2 May 2026" / "2 مايو 2026" — day-first per §4. */
export function formatDate(
  date: Date | string | number,
  locale: Locale,
): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(intlLocale(locale), {
    ...NUM_FORCE_LATIN,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

/** "14:35" (24h, both locales). */
export function formatTime(date: Date | string | number, locale: Locale): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(intlLocale(locale), {
    ...NUM_FORCE_LATIN,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

/** "2 May 2026, 14:35". Combines formatDate + formatTime via Intl. */
export function formatDateTime(
  date: Date | string | number,
  locale: Locale,
): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(intlLocale(locale), {
    ...NUM_FORCE_LATIN,
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

/**
 * "3 days ago" / "منذ 3 أيام". Picks the largest unit that fits — feed it a
 * `Date`, get back a human-friendly relative string in the active locale.
 */
export function formatRelative(
  date: Date | string | number,
  locale: Locale,
  now: Date = new Date(),
): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  const diffSec = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), {
    numeric: "auto",
  });
  if (abs < 60) return rtf.format(diffSec, "second");
  if (abs < 60 * 60) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 60 * 60 * 24) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 60 * 60 * 24 * 30)
    return rtf.format(Math.round(diffSec / (3600 * 24)), "day");
  if (abs < 60 * 60 * 24 * 365)
    return rtf.format(Math.round(diffSec / (3600 * 24 * 30)), "month");
  return rtf.format(Math.round(diffSec / (3600 * 24 * 365)), "year");
}
