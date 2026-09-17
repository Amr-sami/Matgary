/**
 * Deterministic formatters.
 *
 * Doc 06 §4.3: do NOT use Intl on device. Hermes ships a trimmed ICU, so the
 * same number can render with different separators — or different digits — than
 * the web produced for the same tenant. These are plain string ops on purpose.
 */

import { LOCALE } from "@/i18n";

/**
 * 277575 -> "277,575 ج.م" in Arabic, "EGP 277,575" in English — the same two
 * shapes the web's formatCurrency produces (currencyDisplay: "code" for en).
 * Latin digits in both, matching the web's NUM_FORCE_LATIN.
 */
export function money(value: number): string {
  const n = groupDigits(Math.round(value));
  return LOCALE === "en" ? `EGP ${n}` : `${n} ج.م`;
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
