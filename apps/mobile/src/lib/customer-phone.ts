/**
 * The customer route key — `/customers/[phone]` — and the one place the phone
 * that rides in it is normalised.
 *
 * Why this exists: `matgary://customers/%2B201001234013` did not open the
 * customer. The list screen pushes `encodeURIComponent(phone)` (so the "+"
 * survives the URL) and the detail screen decoded once, which is right for
 * in-app navigation. A deep link is another story: depending on who built the
 * URL and which layer parsed it, the `[phone]` param can arrive as any of
 *
 *   "+201001234013"     decoded once (expo-router on an in-app push)
 *   "%2B201001234013"   not decoded at all (custom-scheme link on iOS)
 *   "%252B201001234013" double-encoded (a "+" escaped by two layers)
 *   " 201001234013"     a "+" turned into a space by a querystring-style decoder
 *   "201001234013"      the "+" simply dropped
 *   "01001234013"       the local form, from an older writer
 *
 * `getCustomerLedger` on the server normalises to E.164 before matching, so the
 * request is fine whatever shape the param has — provided it reaches the API
 * as a number. The fix is therefore: decode until no percent-escape is left,
 * repair the "+", and hand the API E.164. Both the push (`customerRoute`) and
 * the read (`customerPhoneParam`) go through here so the route key is the
 * same string on both ends and the query cache keys line up.
 *
 * Mirrors apps/web/lib/validators/egypt.ts#normalizeEgyptPhone for Egyptian
 * mobiles. Imports nothing, so `node --test --experimental-strip-types` loads
 * it directly (see __tests__/customer-phone.test.ts).
 */

const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;

/** Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits → ASCII. */
function asciifyDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/**
 * Percent-decode a route param until it is stable — at most three rounds, so
 * a double-encoded "+" (`%252B`) comes out as "+" and a value with no escapes
 * is returned untouched. A malformed escape (`%E0%A4%A`) throws URIError in
 * `decodeURIComponent`; the last good value wins instead of the screen crashing.
 */
export function decodeRouteParam(raw: string | string[] | undefined | null): string {
  let value = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  for (let i = 0; i < 3 && PERCENT_ESCAPE.test(value); i += 1) {
    try {
      const next = decodeURIComponent(value);
      if (next === value) break;
      value = next;
    } catch {
      break;
    }
  }
  return value;
}

/**
 * E.164 for an Egyptian mobile ("+201001234013"), or `null` when the input is
 * not one. Accepts every stored / typed shape: "+20…", "0020…", "20…", "0…",
 * Arabic-Indic digits, and the separators people type (spaces, dashes, dots,
 * parens). A leading space is read as a mangled "+" (see the module comment).
 */
export function toE164(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = asciifyDigits(String(raw))
    .replace(/^\s+/, "+")
    .replace(/[\s()\-_.]/g, "");
  if (cleaned.length === 0) return null;

  let digits = cleaned;
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.startsWith("0020")) digits = digits.slice(4);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  if (digits.startsWith("20")) digits = digits.slice(2);

  // An Egyptian mobile is exactly 10 digits starting with 1, and the real
  // operator prefixes are 10/11/12/15 → second digit ∈ {0,1,2,5}.
  if (!/^1[0125]\d{8}$/.test(digits)) return null;
  return `+20${digits}`;
}

/**
 * What `/customers/[phone]` should use as the phone: the param decoded to a
 * stable value, then E.164. Falls back to the decoded, trimmed string when it
 * is not an Egyptian mobile so the API can answer INVALID_PHONE legibly rather
 * than the client silently inventing a number.
 */
export function customerPhoneParam(raw: string | string[] | undefined | null): string {
  const decoded = decodeRouteParam(raw);
  return toE164(decoded) ?? decoded.trim();
}

/**
 * The route to push for a customer. Normalises first so every entry point —
 * list row, top-customer chip, a notification's deep link — lands on the same
 * key and the detail screen's query cache is shared between them.
 */
export function customerRoute(phone: string): string {
  return `/customers/${encodeURIComponent(toE164(phone) ?? phone.trim())}`;
}
