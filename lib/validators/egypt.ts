// Egyptian phone-number normalizer.
//
// Egyptian mobile numbers are 10 digits beginning with `1` after the country
// code: `+20 1X XXXX XXXX`. Operators today (2026): 010, 011, 012, 015 → all
// start with 1 once you strip the leading 0. We accept input that arrives as:
//
//   "01001234567"            (national format with leading 0)
//   "1001234567"             (no leading 0, no country code)
//   "+201001234567"          (canonical international)
//   "00201001234567"         (international with 00 prefix)
//   "+20 100 123 4567"       (with spaces / dashes)
//   "٠١٠٠١٢٣٤٥٦٧"           (Arabic-Indic digits)
//
// All of those collapse to the canonical `+201001234567`.

const ARABIC_DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  // Persian variant — sometimes leaks in via copy-paste.
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

function asciifyDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (ch) => ARABIC_DIGITS[ch] ?? ch);
}

/**
 * Try to coerce a free-form phone string into the canonical `+201XXXXXXXXX`
 * shape. Returns null when the input clearly isn't an Egyptian mobile number.
 *
 * Pure function — no side effects, safe to call from anywhere (server, edge,
 * client). Useful both for storage normalisation and as a `safeParse` step
 * inside zod schemas.
 */
export function normalizeEgyptPhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  // Strip whitespace, parens, dashes, plus signs (we'll re-add the +).
  const cleaned = asciifyDigits(String(raw))
    .replace(/[\s()\-_.]/g, "")
    .trim();
  if (cleaned.length === 0) return null;

  let digits = cleaned;
  // Drop common international prefixes before pattern-matching.
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("0020")) digits = digits.slice(4);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  if (digits.startsWith("20")) digits = digits.slice(2);

  // After stripping, an Egyptian mobile is exactly 10 digits starting with 1.
  if (!/^1\d{9}$/.test(digits)) return null;

  // Bonus tightness: real prefixes are 10/11/12/15 → second digit ∈ {0,1,2,5}.
  if (!"0125".includes(digits[1])) return null;

  return `+20${digits}`;
}

export function isValidEgyptPhone(raw: string | null | undefined): boolean {
  return normalizeEgyptPhone(raw) !== null;
}
