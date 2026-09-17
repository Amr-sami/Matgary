/**
 * Deterministic formatters.
 *
 * Doc 06 §4.3: do NOT use Intl on device. Hermes ships a trimmed ICU, so the
 * same number can render with different separators — or different digits — than
 * the web produced for the same tenant. These are plain string ops on purpose.
 */

/** 277575 -> "277,575 ج.م". Latin digits, matching the web's screenshots. */
export function money(value: number): string {
  return `${groupDigits(Math.round(value))} ج.م`;
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
