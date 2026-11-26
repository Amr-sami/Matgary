/**
 * Deterministic formatters.
 *
 * Doc 06 §4.3: do NOT use Intl on device. Hermes ships a trimmed ICU, so the
 * same number can render with different separators — or different digits — than
 * the web produced for the same tenant. These are plain string ops on purpose.
 *
 * Everything here reads the dictionary at CALL time (i.e. during render), never
 * at module scope, so a live language switch is picked up on the remount that
 * follows it (see i18n/index.ts). Call these from render, not from a
 * StyleSheet or a module-level constant.
 */

import { isRTL, t } from "@/i18n";

/** Strong, zero-width direction marks — UAX#9 bidi types R and L. */
const RLM = "\u200F";
const LRM = "\u200E";

/* -------------------------------------------------------------------- money */

/**
 * 277575 -> "277,575 ج.م" in Arabic, "EGP 277,575" in English — the same two
 * shapes the web's formatCurrency produces (currencyDisplay: "code" for en).
 * Latin digits in both, matching the web's NUM_FORCE_LATIN.
 *
 * The dictionary owns the shape (suffix vs prefix) via `mobile.format.money`,
 * so a locale switch re-reads it on the next render — no shape branch here.
 *
 * Bidi: the Arabic shape wraps "{amount} ج.م" in an RLI…PDI isolate
 * (U+2067/U+2069) so the number and its unit never split around neighbouring
 * text. But UAX#9 P2 SKIPS isolates when it picks the paragraph direction, so
 * a composite that begins with money() and continues with neutrals only —
 * "{amount} · 32%" — has no strong character left, follows the DEVICE
 * language, and paints "ج.م 400 · 32%" on an en-US phone but "32% · ج.م 400"
 * on an Arabic one. The leading mark below (RLM in Arabic, LRM in English)
 * sits OUTSIDE the isolate and is the paragraph's first strong character, so
 * the composite follows the app locale on every device. It is zero-width;
 * the isolate around the number stays.
 */
export function money(value: number): string {
  const n = groupDigits(Math.round(value));
  return (isRTL() ? RLM : LRM) + t("mobile.format.money", { amount: n });
}

export function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * "160.0K" in English, "160.0 ألف" in Arabic — the dictionary owns the suffix
 * (`mobile.format.thousand` / `.million`) so a K/M never leaks into an Arabic
 * screen (same rule as money()). For chart cells and heat-map totals where the
 * unit would not fit; use money() wherever there is room for it.
 */
export function compact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return t("mobile.format.million", { n: (n / 1_000_000).toFixed(1) });
  if (Math.abs(n) >= 1_000) return t("mobile.format.thousand", { n: (n / 1_000).toFixed(1) });
  return groupDigits(Math.round(n));
}

/* ------------------------------------------------------------------ plurals */

/** The count forms a dictionary key may carry beside its default. */
export type CountForm = "One" | "Two" | "Few" | "Many";

/**
 * Arabic counts 1 / 2 / 3–10 / everything else (0, 11+) differently, so the
 * dictionary carries `xOne`, `xTwo`, `xFew` beside the default `x`. This is
 * the ONE classifier — do not copy it into a screen.
 *
 * "Many" is a real form here, not "": a template caller
 * (`t(\`${key}${countForm(n)}\`)`) would look up `xMany`, which the
 * dictionaries do not carry, and get the raw path back. Go through
 * countLabel(), which falls back to the base key.
 */
export function countForm(n: number): CountForm {
  if (n === 1) return "One";
  if (n === 2) return "Two";
  if (n >= 3 && n <= 10) return "Few";
  return "Many";
}

/**
 * countLabel("mobile.catalog.attributeCount", 2) -> t("mobile.catalog.attributeCountTwo", { n: 2 }).
 *
 * Resolves `${baseKey}${countForm(n)}` and falls back to `baseKey` when that
 * locale does not carry the form (English needs only One; nothing carries
 * Many yet — add `xMany` to the dictionary and it is picked up here). `n` is
 * always available to the template; `params` adds or overrides — `{ date }`
 * for "{n} items · {date}".
 */
export function countLabel(baseKey: string, n: number, params?: Record<string, string | number>): string {
  const vars = { n, ...params };
  const key = `${baseKey}${countForm(n)}`;
  const s = t(key, vars);
  // lookup() echoes the path back when the key is missing.
  return s === key ? t(baseKey, vars) : s;
}

/* -------------------------------------------------------------------- dates */

/**
 * One date grammar app-wide. Month names come from the dictionary
 * (`mobile.insights.month.*`) — "Sep" / "سبتمبر" — and the dictionary owns the
 * day / month / year order per locale: `mobile.format.date` for a full date,
 * `mobile.insights.peakDate` for day + month (chart axis ends and the Overview
 * peak caption). Day-first in both languages, the web's §4 rule ("2 May 2026").
 *
 * The numeric "14/09/2026" was dropped: one tab away from a "14 Sep" caption it
 * looked like a second format, on an en-US phone "12/09" read as December 9,
 * and — all-weak characters — it took its direction from the device. A month
 * name is a strong character, so a bare date now anchors its own paragraph.
 * Intl stays out (see the header note).
 */
const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** 0-based month index -> localized short name ("Sep" / "سبتمبر"); "" when out of range. */
export function monthName(index: number): string {
  const key = MONTH_KEYS[index];
  return key ? t(`mobile.insights.month.${key}`) : "";
}

/**
 * ISO (or "YYYY-MM-DD") -> "19 Sep 2026" / "19 سبتمبر 2026" in the phone's
 * local time; "—" when empty or unparseable. Every dated row, hint and
 * DateField in the app goes through here, so the shape changes in one place.
 */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return t("mobile.format.date", {
    day: String(d.getDate()),
    month: monthName(d.getMonth()),
    year: String(d.getFullYear()),
  });
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
