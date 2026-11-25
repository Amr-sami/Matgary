/**
 * Shared normalization + fuzzy scoring for entity resolution.
 *
 * Why in-house instead of pg_trgm / Fuse.js:
 *   • Zero new dependencies — the F-plan explicitly prefers smaller bundles.
 *   • The `products` table has no trigram / fulltext index (confirmed by audit).
 *     An `ILIKE %q%` scan is fine for the small dev/prod shops we target now
 *     (< 10k products); migrating to pg_trgm later is a repo-only change that
 *     doesn't touch this module.
 *   • The Arabic ↔ Latin transliteration quirks are shop-specific; doing it
 *     here keeps intent readable.
 *
 * All exports are pure functions — safe for direct use in tool handlers.
 */

/* ──────────────────────────────── digits ──────────────────────────────── */

const ARABIC_INDIC = /[٠-٩]/g;
const PERSIAN_DIGITS = /[۰-۹]/g;

export function normalizeDigits(s: string): string {
  return s
    .replace(ARABIC_INDIC, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(PERSIAN_DIGITS, (c) => String(c.charCodeAt(0) - 0x06f0));
}

/* ──────────────────────────────── Arabic ──────────────────────────────── */

/** Tashkeel (combining diacritics) and tatweel. Dropped before scoring. */
const TASHKEEL = /[ً-ْٰـ]/g;

/** Alif variants → bare alif; yaa/alif-maksura variants → yaa; taa marbuta → haa.
 *  This matches the common Arabic-search convention Egyptian shop owners use
 *  (they type whichever variant is on the keyboard). */
const AR_SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/[أإآٱ]/g, "ا"], // أإآٱ → ا
  [/ة/g, "ه"],                      // ة → ه
  [/[ىي]/g, "ي"],              // ى → ي (keep as ي)
  [/ؤ/g, "و"],                      // ؤ → و
  [/ئ/g, "ي"],                      // ئ → ي
];

export function normalizeArabic(s: string): string {
  let out = s.replace(TASHKEEL, "");
  for (const [re, sub] of AR_SUBSTITUTIONS) out = out.replace(re, sub);
  return out;
}

/* ─────────────────────────── transliteration ───────────────────────────── */

/**
 * Latin ↔ Arabic phonetic bridge. This turns "assaf" and "أساف" into the SAME
 * canonical token so a Latin-typed query matches an Arabic product name (and
 * vice versa). It's deliberately lossy: the goal is to make FOLDING consistent,
 * not to do full romanization.
 *
 * We operate by mapping Arabic letters to a Latin phonetic family, then
 * collapsing both input and candidate to the same alphabet for comparison.
 */
const AR_TO_LAT: Record<string, string> = {
  "ا": "a", // ا
  "ب": "b", // ب
  "ت": "t", // ت
  "ث": "s", // ث → s (Egyptian pronunciation)
  "ج": "g", // ج → g (Egyptian pronunciation)
  "ح": "h", // ح
  "خ": "k", // خ
  "د": "d", // د
  "ذ": "z", // ذ → z (Egyptian pronunciation)
  "ر": "r", // ر
  "ز": "z", // ز
  "س": "s", // س
  "ش": "s", // ش → s (lossy fold so "shams" and "sams" match)
  "ص": "s", // ص
  "ض": "d", // ض
  "ط": "t", // ط
  "ظ": "z", // ظ
  "ع": "a", // ع
  "غ": "g", // غ
  "ف": "f", // ف
  "ق": "k", // ق → k (Egyptian pronunciation)
  "ك": "k", // ك
  "ل": "l", // ل
  "م": "m", // م
  "ن": "n", // ن
  "ه": "h", // ه
  "و": "w", // و
  "ي": "y", // ي
};

export function transliterateArabicToLatin(s: string): string {
  let out = "";
  for (const ch of s) {
    const mapped = AR_TO_LAT[ch];
    out += mapped !== undefined ? mapped : ch;
  }
  return out;
}

/* ────────────────────────── canonical folding ─────────────────────────── */

/**
 * The single string we actually compare on. Combines:
 *   1. Arabic normalization (alif/yaa/haa/tashkeel)
 *   2. Arabic→Latin transliteration (so "assaf" == "أساف")
 *   3. Digit normalization (٠-٩ → 0-9)
 *   4. Lowercase
 *   5. Collapse whitespace + strip common punctuation
 *   6. Drop doubled Latin letters ("assaaf" → "asaf" → canonical "asaf")
 *
 * After folding, a token is either "equal to" or "contains" the candidate.
 * The resulting string has no Arabic script. Keep for internal use only —
 * NEVER display it to the user.
 */
export function canonical(s: string): string {
  if (!s) return "";
  let out = normalizeArabic(s);
  out = transliterateArabicToLatin(out);
  out = normalizeDigits(out);
  out = out.toLowerCase();
  out = out.replace(/[\p{P}\p{S}]/gu, " "); // punctuation / symbols → space
  out = out.replace(/\s+/g, " ").trim();
  out = out.replace(/(.)\1+/g, "$1"); // collapse "ss" → "s", "aa" → "a"
  return out;
}

/** Split into comparison tokens (space-separated, non-empty). */
export function tokens(s: string): string[] {
  const c = canonical(s);
  if (!c) return [];
  return c.split(" ").filter(Boolean);
}

/* ───────────────────────────── scorer ─────────────────────────────────── */

/**
 * Score a query against a candidate on [0, 1]:
 *   1.00 — canonical forms equal
 *   0.95 — all query tokens appear as whole tokens inside candidate
 *   0.85 — canonical candidate CONTAINS canonical query (substring)
 *   0.55 — >= 50% of query tokens have a prefix hit in candidate
 *   0.00 — otherwise
 *
 * We return the max over ALL searchable fields the caller passes in (name,
 * brand, sku). Caller decides how to combine when the same candidate matches
 * on multiple fields.
 */
export function score(query: string, candidate: string): number {
  const q = canonical(query);
  const c = canonical(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  const qTokens = q.split(" ").filter(Boolean);
  const cTokens = new Set(c.split(" ").filter(Boolean));
  if (qTokens.every((t) => cTokens.has(t))) return 0.95;
  if (c.includes(q)) return 0.85;
  const prefixHits = qTokens.filter((t) =>
    Array.from(cTokens).some((ct) => ct.startsWith(t) || t.startsWith(ct)),
  ).length;
  if (qTokens.length > 0 && prefixHits / qTokens.length >= 0.5) return 0.55;
  return 0;
}

/* ─────────────────────── SKU / barcode normalization ──────────────────── */

/** Strip every non-alphanumeric so a barcode with spaces/dashes still matches.
 *  Mirrors the pg expression index `products_tenant_norm_sku_idx`. */
export function normalizeSku(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
