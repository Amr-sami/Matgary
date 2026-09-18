/**
 * Deterministic formatters.
 *
 * Doc 06 §4.3: do NOT use Intl on device. Hermes ships a trimmed ICU, so the
 * same number can render with different separators — or different digits — than
 * the web produced for the same tenant. These are plain string ops on purpose.
 */

import { t } from "@/i18n";

/**
 * 277575 -> "277,575 ج.م" in Arabic, "EGP 277,575" in English — the same two
 * shapes the web's formatCurrency produces (currencyDisplay: "code" for en).
 * Latin digits in both, matching the web's NUM_FORCE_LATIN.
 *
 * The dictionary owns the shape (suffix vs prefix) via `mobile.format.money`,
 * so a locale switch re-reads it on the next render — no locale branch here.
 */
export function money(value: number): string {
  const n = groupDigits(Math.round(value));
  return t("mobile.format.money", { amount: n });
}

export function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** ISO -> "14/09/2026". */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/**
 * Month names come from the dictionary (`mobile.insights.month.*`) so the chart
 * axes and the Overview peak caption speak the same language — "18 Sep" in
 * English, "18 سبتمبر" in Arabic. The numeric "18/09" was dropped: one tap away
 * from a "Sep 14" caption it looked like a second format, and on an en-US
 * phone "12/09" reads as December 9. Intl stays out (see the header note).
 */
const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** 0-based month index -> localized short name ("Sep" / "سبتمبر"); "" when out of range. */
export function monthName(index: number): string {
  const key = MONTH_KEYS[index];
  return key ? t(`mobile.insights.month.${key}`) : "";
}

/**
 * "YYYY-MM-DD" (or ISO) -> "18 Sep" / "18 سبتمبر" — chart axis ends, in the
 * same shape as the Overview peak caption (`mobile.insights.peakDate`, which
 * owns the day/month order per locale). Plain string ops, no Date: an ISO with
 * a "Z" must not drift a day on a UTC+2 phone.
 */
export function dayMonth(day: string | null | undefined): string {
  if (!day) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return "";
  const month = monthName(Number(m[2]) - 1);
  if (!month) return "";
  return t("mobile.insights.peakDate", { day: String(Number(m[3])), month });
}
